import { Hono } from "hono";
import { logger } from "hono/logger";

import { getUsers } from "./lib/db.js";
import { login, register, getUserByToken } from "./lib/auth.js";
import { getCoupleForUser, createCouple, joinCouple, setNextTrip, setHasMet, completeDay, coupleDayString } from "./lib/couple.js";
import {
	getTodayQuestion, submitAnswer, toggleAnswerReaction,
	addMessage, toggleMessageReaction, deleteMessage, markMessagesRead,
} from "./lib/questions.js";
import { featured as gifFeatured, search as gifSearch, isConfigured as gifConfigured } from "./lib/giphy.js";
import { createMoment, listMoments } from "./lib/moments.js";
import { sendPing, todayCounts } from "./lib/pings.js";
import { upsertPresence, getPresences } from "./lib/presence.js";
import { listWords, addWord } from "./lib/words.js";
import { registerToken, removeToken, notifyUser } from "./lib/push.js";
import { isConfigured as apnsConfigured } from "./lib/apns.js";

const app = new Hono();

// Request logging — so traffic is actually visible in the dokploy logs.
app.use("*", logger());

app.get("/", (c) => c.text("sempurna-api ok\n"));
app.get("/health", (c) => c.json({ ok: true, service: "sempurna-api" }));

// --- Auth (no token required) ---
// Sempurna owns its users: the first two accounts to register are the couple,
// then registration closes itself. No shared auth, no allowlist needed.
app.post("/api/auth/register", async (c) => {
	const { username, password } = await c.req.json().catch(() => ({}));
	const result = await register((username || "").trim(), password);
	if (result.error) return c.json({ error: result.error }, result.error === "couple_full" ? 403 : 400);
	return c.json({ token: result.token, me: serializeUser(result.user) });
});

app.post("/api/auth/login", async (c) => {
	const { username, password } = await c.req.json().catch(() => ({}));
	const result = await login((username || "").trim(), password);
	if (!result) return c.json({ error: "invalid_credentials" }, 401);
	return c.json({ token: result.token, me: serializeUser(result.user) });
});

// --- Bearer auth for everything else ---
const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/register"]);
app.use("/api/*", async (c, next) => {
	if (PUBLIC_PATHS.has(c.req.path)) return next();
	const header = c.req.header("Authorization") || "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : null;
	const user = await getUserByToken(token);
	if (!user) return c.json({ error: "unauthorized" }, 401);
	c.set("user", user);
	await next();
});

// --- Serializers ---
const serializeUser = (u) => ({ id: u._id.toString(), name: u.username });

const serializeMoment = (m) => ({
	id: m._id.toString(),
	from: m.fromUserId.toString(),
	note: m.note,
	emoji: m.emoji,
	paletteIndex: m.paletteIndex,
	photoUrl: m.photoUrl ?? null,
	date: m.createdAt.toISOString(),
});

const serializePresence = (p) => ({
	userId: p.userId.toString(),
	city: p.city,
	flag: p.flag,
	timeZoneID: p.timeZoneID,
	date: p.updatedAt.toISOString(),
});

const serializeWord = (w) => ({
	id: w._id.toString(),
	indonesian: w.indonesian,
	french: w.french,
	english: w.english,
	note: w.note,
	addedBy: w.addedBy.toString(),
});

async function ctxFor(user) {
	const couple = await getCoupleForUser(user._id);
	if (!couple) return { couple: null, me: user, partner: null };
	const partnerEntry = couple.users.find((u) => !u.userId.equals(user._id));
	const partner = partnerEntry
		? await (await getUsers()).findOne({ _id: partnerEntry.userId })
		: null;
	return { couple, me: user, partner };
}

// --- Home: the one-shot launch snapshot the iOS app boots from ---
app.get("/api/home", async (c) => {
	const x = await ctxFor(c.get("user"));
	const tzOffset = parseInt(c.req.query("tzOffset") || "0", 10) || 0;

	if (!x.couple) {
		return c.json({ status: "noCouple", me: serializeUser(x.me), partner: null,
			inviteCode: null, nextTrip: null, presences: [], moments: [], pings: { sent: 0, received: 0 } });
	}

	const userIds = x.couple.users.map((u) => u.userId);
	const [moments, presences, pings] = await Promise.all([
		listMoments(x.couple._id),
		getPresences(userIds),
		todayCounts(x.couple._id, x.me._id, tzOffset),
	]);

	return c.json({
		status: x.partner ? "ready" : "waiting",
		me: serializeUser(x.me),
		partner: x.partner ? serializeUser(x.partner) : null,
		inviteCode: x.partner ? null : x.couple.inviteCode,
		hasMet: !!x.couple.hasMet,
		nextTrip: x.couple.nextTrip ?? null,
		presences: presences.map(serializePresence),
		moments: moments.map(serializeMoment),
		pings,
	});
});

// --- Profile: rename yourself (the partner sees it on their next refresh) ---
app.post("/api/user/username", async (c) => {
	const user = c.get("user");
	const { username } = await c.req.json().catch(() => ({}));
	const name = (username || "").trim();
	if (!/^[a-z0-9_.-]{2,24}$/i.test(name)) return c.json({ error: "invalid_username" }, 400);

	const users = await getUsers();
	const existing = await users.findOne({ username: name });
	if (existing && !existing._id.equals(user._id)) return c.json({ error: "username_taken" }, 400);

	await users.updateOne({ _id: user._id }, { $set: { username: name } });
	return c.json({ ok: true, me: { id: user._id.toString(), name } });
});

// --- Pairing: create the couple / join with the invite code ---
app.post("/api/couple", async (c) => {
	const user = c.get("user");
	const { timeZoneID } = await c.req.json().catch(() => ({}));
	const created = await createCouple(user._id, timeZoneID);
	if (!created) return c.json({ error: "exists" }, 409);
	return c.json({ ok: true, inviteCode: created.inviteCode });
});

app.post("/api/join", async (c) => {
	const user = c.get("user");
	const { code } = await c.req.json().catch(() => ({}));
	const coupleId = await joinCouple(code, user._id);
	if (!coupleId) return c.json({ error: "invalid_code" }, 400);
	return c.json({ ok: true });
});

// --- Moments ---
app.get("/api/moments", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json([]);
	return c.json((await listMoments(x.couple._id)).map(serializeMoment));
});

app.post("/api/moments", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const { note, emoji, paletteIndex, photoBase64 } = await c.req.json().catch(() => ({}));
	if (!note || !note.trim()) return c.json({ error: "empty" }, 400);

	const res = await createMoment(x.couple._id, x.me._id, {
		note: note.trim(), emoji, paletteIndex, photoBase64,
	});
	if (!res.ok) return c.json(res, 400);

	if (x.partner) {
		notifyUser(x.partner._id, {
			title: `New moment from ${x.me.username} ${res.moment.emoji}`,
			body: res.moment.note,
			data: { kind: "moment", id: res.moment._id.toString() },
		}).catch(() => {});
	}
	return c.json(serializeMoment(res.moment));
});

// --- Ping ("thinking of you") ---
app.post("/api/ping", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const tzOffset = parseInt(c.req.query("tzOffset") || "0", 10) || 0;

	await sendPing(x.couple._id, x.me._id);
	if (x.partner) {
		notifyUser(x.partner._id, {
			title: "Sempurna 💌",
			body: `${x.me.username} is thinking of you`,
			data: { kind: "ping" },
		}).catch(() => {});
	}
	return c.json({ ok: true, pings: await todayCounts(x.couple._id, x.me._id, tzOffset) });
});

// --- Daily question + its chat ---

// The blind-reveal and the chat lock are enforced HERE, not in the client:
// the partner's answer only ships once you've answered, messages only once both did.
function serializeQuestion(q, couple, meId, partnerId) {
	const myAnswer = q.answers?.[meId]?.text ?? null;
	const partnerAnswerRaw = partnerId ? (q.answers?.[partnerId]?.text ?? null) : null;
	const chatUnlocked = !!(myAnswer && partnerAnswerRaw);
	return {
		date: q.date,
		prompt: q.questionText,
		spicy: !!q.spicy,
		streak: couple.streak || 0,
		myAnswer,
		partnerHasAnswered: !!partnerAnswerRaw,
		partnerAnswer: myAnswer ? partnerAnswerRaw : null,
		myReaction: (partnerId && q.reactions?.[meId]?.[partnerId]) || null,
		partnerReaction: (partnerId && q.reactions?.[partnerId]?.[meId]) || null,
		chatUnlocked,
		messages: chatUnlocked
			? (q.comments || []).map((m, i) => ({
				id: i,
				from: m.userId === meId ? "me" : "partner",
				text: m.text || "",
				gif: m.gif || null,
				at: new Date(m.createdAt).toISOString(),
				myReaction: m.reactions?.[meId] ?? null,
				partnerReaction: partnerId ? (m.reactions?.[partnerId] ?? null) : null,
				read: !!m.read,
			}))
			: [],
	};
}

async function questionState(x) {
	const todayStr = coupleDayString(x.couple);
	// Re-read the couple so a completeDay from this request shows the fresh streak.
	const q = await getTodayQuestion(x.couple, todayStr);
	await markMessagesRead(x.couple._id, todayStr, x.me._id.toString());
	const couple = await getCoupleForUser(x.me._id);
	return serializeQuestion(q, couple, x.me._id.toString(),
		x.partner ? x.partner._id.toString() : null);
}

app.get("/api/question", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	return c.json(await questionState(x));
});

app.post("/api/question/answer", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const { text } = await c.req.json().catch(() => ({}));
	if (!text || !text.trim()) return c.json({ error: "empty" }, 400);

	const todayStr = coupleDayString(x.couple);
	await getTodayQuestion(x.couple, todayStr);   // make sure today's doc exists
	const updated = await submitAnswer(x.couple._id, todayStr, x.me._id.toString(), text.trim());

	const answers = updated?.answers || {};
	const both = x.partner && answers[x.me._id.toString()] && answers[x.partner._id.toString()];
	if (both) await completeDay(x.couple._id, todayStr);

	if (x.partner) {
		notifyUser(x.partner._id, both
			? { title: "You both answered 💞", body: "The chat is open — come see!", data: { kind: "question", date: todayStr } }
			: { title: `${x.me.username} answered today's question 👀`, body: "Your turn — answer to reveal it", data: { kind: "question", date: todayStr } },
		).catch(() => {});
	}
	return c.json(await questionState(x));
});

// React to the partner's pinned answer.
app.post("/api/question/reaction", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple || !x.partner) return c.json({ error: "not_ready" }, 400);
	const { emoji } = await c.req.json().catch(() => ({}));

	const todayStr = coupleDayString(x.couple);
	const current = await getTodayQuestion(x.couple, todayStr);
	const existing = current?.reactions?.[x.me._id.toString()]?.[x.partner._id.toString()];
	await toggleAnswerReaction(x.couple._id, todayStr, x.me._id.toString(),
		x.partner._id.toString(), existing === emoji ? null : emoji);
	return c.json(await questionState(x));
});

// Chat under the question — only once both answered.
async function requireUnlockedChat(x) {
	const todayStr = coupleDayString(x.couple);
	const q = await getTodayQuestion(x.couple, todayStr);
	const both = x.partner
		&& q.answers?.[x.me._id.toString()] && q.answers?.[x.partner._id.toString()];
	return both ? todayStr : null;
}

app.post("/api/question/message", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const { text, gif } = await c.req.json().catch(() => ({}));
	const hasGif = gif && typeof gif.url === "string";
	if ((!text || !text.trim()) && !hasGif) return c.json({ error: "empty" }, 400);

	const todayStr = await requireUnlockedChat(x);
	if (!todayStr) return c.json({ error: "chat_locked" }, 403);

	await addMessage(x.couple._id, todayStr, x.me._id.toString(),
		(text || "").trim(), hasGif ? gif : null);
	notifyUser(x.partner._id, {
		title: x.me.username,
		body: hasGif ? "GIF 🎞️" : (text.trim().length > 120 ? text.trim().slice(0, 117) + "…" : text.trim()),
		data: { kind: "question", date: todayStr },
	}).catch(() => {});
	return c.json(await questionState(x));
});

app.post("/api/question/message/:index/reaction", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const index = parseInt(c.req.param("index"), 10);
	const { emoji } = await c.req.json().catch(() => ({}));

	const todayStr = await requireUnlockedChat(x);
	if (!todayStr) return c.json({ error: "chat_locked" }, 403);

	const updated = await toggleMessageReaction(x.couple._id, todayStr, index, x.me._id.toString(), emoji);
	if (!updated) return c.json({ error: "not_found" }, 404);
	return c.json(await questionState(x));
});

app.delete("/api/question/message/:index", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const index = parseInt(c.req.param("index"), 10);

	const todayStr = await requireUnlockedChat(x);
	if (!todayStr) return c.json({ error: "chat_locked" }, 403);

	const updated = await deleteMessage(x.couple._id, todayStr, index, x.me._id.toString());
	if (!updated) return c.json({ error: "not_found" }, 404);
	return c.json(await questionState(x));
});

// --- GIFs (Giphy proxy, key stays server-side) ---
app.get("/api/gifs", async (c) => {
	if (!gifConfigured()) return c.json({ configured: false, trending: [] });
	return c.json({ configured: true, trending: await gifFeatured(24).catch(() => []) });
});

app.get("/api/gifs/search", async (c) => {
	const q = (c.req.query("q") || "").trim();
	if (!q) return c.json({ results: [] });
	return c.json({ results: await gifSearch(q, 30).catch(() => []) });
});

// --- Presence (device geolocation → partner's clocks) ---
app.post("/api/presence", async (c) => {
	const user = c.get("user");
	const { city, flag, timeZoneID } = await c.req.json().catch(() => ({}));
	if (!city || !timeZoneID) return c.json({ error: "missing" }, 400);
	await upsertPresence(user._id, { city, flag, timeZoneID });
	return c.json({ ok: true });
});

// --- Have we met in person yet? (drives question wording + Us copy) ---
app.post("/api/couple/met", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const { met } = await c.req.json().catch(() => ({}));
	await setHasMet(x.couple._id, !!met);
	return c.json({ ok: true, hasMet: !!met });
});

// --- Next trip (Us tab countdown) ---
app.post("/api/trip", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const { date } = await c.req.json().catch(() => ({}));
	const res = await setNextTrip(x.couple._id, date || null);
	if (!res.ok) return c.json(res, 400);
	return c.json(res);
});

// --- Words (Kamus shared dictionary) ---
app.get("/api/words", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json([]);
	return c.json((await listWords(x.couple._id)).map(serializeWord));
});

app.post("/api/words", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const { indonesian, french, english, note } = await c.req.json().catch(() => ({}));
	if (!indonesian || !french || !english) return c.json({ error: "missing" }, 400);
	const doc = await addWord(x.couple._id, x.me._id, { indonesian, french, english, note });
	return c.json(serializeWord(doc));
});

// --- Push notifications ---
app.post("/api/push/register", async (c) => {
	const user = c.get("user");
	const { token, platform } = await c.req.json().catch(() => ({}));
	if (!token) return c.json({ error: "no_token" }, 400);
	await registerToken(user._id, token, platform || "ios");
	return c.json({ ok: true });
});

app.post("/api/push/unregister", async (c) => {
	const { token } = await c.req.json().catch(() => ({}));
	await removeToken(token);
	return c.json({ ok: true });
});

// Send a test push to the caller's own devices.
app.post("/api/push/test", async (c) => {
	const user = c.get("user");
	if (!apnsConfigured()) return c.json({ error: "apns_not_configured" }, 503);
	const results = await notifyUser(user._id, {
		title: "Sempurna 💗",
		body: "Push notifications are working!",
	});
	return c.json({ ok: true, env: process.env.APNS_ENV || "production", results });
});

const port = Number(process.env.PORT || 3000);
console.log(`💗 sempurna-api listening on 0.0.0.0:${port} (env=${process.env.NODE_ENV ?? "dev"}, mongo=${process.env.MONGO_URI ? "set" : "MISSING"})`);

export default { port, hostname: "0.0.0.0", fetch: app.fetch };
