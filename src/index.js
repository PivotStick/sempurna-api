import { Hono } from "hono";
import { logger } from "hono/logger";

import { getUsers } from "./lib/db.js";
import { login, register, getUserByToken } from "./lib/auth.js";
import { getCoupleForUser, createCouple, joinCouple, setNextTrip, setHasMet, setLongDistance, completeDay, coupleDayString } from "./lib/couple.js";
import {
	getTodayQuestion, submitAnswer, toggleAnswerReaction,
	addMessage, toggleMessageReaction, deleteMessage, markMessagesRead,
} from "./lib/questions.js";
import { featured as gifFeatured, search as gifSearch, isConfigured as gifConfigured } from "./lib/giphy.js";
import { createMoment, listMoments } from "./lib/moments.js";
import { sendPing, todayCounts } from "./lib/pings.js";
import { upsertPresence, getPresences } from "./lib/presence.js";
import { listWords, addWord, deleteWord, addVoice, deleteVoice } from "./lib/words.js";
import { listJokes, addJoke, deleteJoke } from "./lib/jokes.js";
import { ObjectId } from "mongodb";
import { registerToken, removeToken, notifyUser } from "./lib/push.js";
import { isConfigured as apnsConfigured } from "./lib/apns.js";
import { startScheduler } from "./lib/scheduler.js";

const app = new Hono();

// Request logging — so traffic is actually visible in the dokploy logs.
app.use("*", logger());

app.get("/", (c) => c.text("sempurna-api ok\n"));
app.get("/health", (c) => c.json({ ok: true, service: "sempurna-api" }));

// --- Auth (no token required) ---
// Sempurna owns its users. Registration is open (the app only reaches
// friends via TestFlight); couples still cap at two members each.
app.post("/api/auth/register", async (c) => {
	const { username, password, language } = await c.req.json().catch(() => ({}));
	const result = await register((username || "").trim(), password, language);
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
const serializeUser = (u) => ({ id: u._id.toString(), name: u.username, language: u.language || "en" });

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
	texts: w.texts || {},
	note: w.note,
	addedBy: w.addedBy.toString(),
	voices: (w.voices || []).map((v) => ({
		id: v._id.toString(),
		url: v.url,
		duration: v.duration || 0,
		addedBy: v.addedBy.toString(),
		date: new Date(v.createdAt).toISOString(),
	})),
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
		notificationsEnabled: !x.me.notificationsMuted,
		me: serializeUser(x.me),
		partner: x.partner ? serializeUser(x.partner) : null,
		inviteCode: x.partner ? null : x.couple.inviteCode,
		hasMet: !!x.couple.hasMet,
		longDistance: x.couple.longDistance !== false,
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

// --- Profile: per-user notification mute (server-side, all devices) ---
app.post("/api/user/notifications", async (c) => {
	const user = c.get("user");
	const { enabled } = await c.req.json().catch(() => ({}));
	await (await getUsers()).updateOne({ _id: user._id }, { $set: { notificationsMuted: !enabled } });
	return c.json({ ok: true, enabled: !!enabled });
});

// --- Pairing: create the couple / join with the invite code ---
app.post("/api/couple", async (c) => {
	const user = c.get("user");
	const { timeZoneID, longDistance } = await c.req.json().catch(() => ({}));
	const created = await createCouple(user._id, timeZoneID, longDistance !== false);
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

// --- Change your language (word entries use these codes) ---
app.post("/api/user/language", async (c) => {
	const user = c.get("user");
	const { language } = await c.req.json().catch(() => ({}));
	if (!/^[a-z]{2,3}$/i.test(language || "")) return c.json({ error: "invalid_language" }, 400);
	await (await getUsers()).updateOne({ _id: user._id }, { $set: { language: language.toLowerCase() } });
	return c.json({ ok: true, language: language.toLowerCase() });
});

// --- Long distance? (drives question wording + the Us countdown) ---
app.post("/api/couple/distance", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const { longDistance } = await c.req.json().catch(() => ({}));
	await setLongDistance(x.couple._id, !!longDistance);
	return c.json({ ok: true, longDistance: !!longDistance });
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
	const { texts, note } = await c.req.json().catch(() => ({}));
	const doc = await addWord(x.couple._id, x.me._id, { texts, note });
	if (!doc) return c.json({ error: "missing" }, 400);
	if (x.partner) {
		const [first, second] = Object.values(doc.texts);
		notifyUser(x.partner._id, {
			title: "New word in your kamus 📖",
			body: `${x.me.username} added “${first}” — ${second}`,
			data: { kind: "word" },
		}).catch(() => {});
	}
	return c.json(serializeWord(doc));
});

// Voice notes: hear each other pronounce the words 🎙️
app.post("/api/words/:id/voice", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	let wordId; try { wordId = new ObjectId(c.req.param("id")); } catch { return c.json({ error: "bad_id" }, 400); }
	const { audioBase64, duration } = await c.req.json().catch(() => ({}));

	const res = await addVoice(x.couple._id, wordId, x.me._id, { audioBase64, duration });
	if (res.error) return c.json(res, res.error === "not_found" ? 404 : 400);

	if (x.partner) {
		notifyUser(x.partner._id, {
			title: `${x.me.username} pronounced “${res.word.indonesian}” 🎙️`,
			body: "Come listen 💗",
			data: { kind: "voice", wordId: wordId.toString() },
		}).catch(() => {});
	}
	return c.json(serializeWord(res.word));
});

app.delete("/api/words/:id/voice/:voiceId", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	let wordId, voiceId;
	try {
		wordId = new ObjectId(c.req.param("id"));
		voiceId = new ObjectId(c.req.param("voiceId"));
	} catch { return c.json({ error: "bad_id" }, 400); }
	const updated = await deleteVoice(x.couple._id, wordId, voiceId, x.me._id);
	if (!updated) return c.json({ error: "not_found" }, 404);
	return c.json(serializeWord(updated));
});

app.delete("/api/words/:id", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	let id; try { id = new ObjectId(c.req.param("id")); } catch { return c.json({ error: "bad_id" }, 400); }
	const ok = await deleteWord(x.couple._id, id);
	return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// --- Inside jokes ---
const serializeJoke = (j) => ({
	id: j._id.toString(),
	title: j.title,
	emoji: j.emoji,
	story: j.story,
	date: j.date.toISOString(),
	addedBy: j.addedBy.toString(),
});

app.get("/api/jokes", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json([]);
	return c.json((await listJokes(x.couple._id)).map(serializeJoke));
});

app.post("/api/jokes", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	const { title, emoji, story, date } = await c.req.json().catch(() => ({}));
	if (!title || !title.trim() || !story || !story.trim()) return c.json({ error: "missing" }, 400);
	const doc = await addJoke(x.couple._id, x.me._id,
		{ title: title.trim(), emoji, story: story.trim(), date });
	if (x.partner) {
		notifyUser(x.partner._id, {
			title: `New inside joke ${doc.emoji}`,
			body: doc.title,
			data: { kind: "joke" },
		}).catch(() => {});
	}
	return c.json(serializeJoke(doc));
});

app.delete("/api/jokes/:id", async (c) => {
	const x = await ctxFor(c.get("user"));
	if (!x.couple) return c.json({ error: "no_couple" }, 400);
	let id; try { id = new ObjectId(c.req.param("id")); } catch { return c.json({ error: "bad_id" }, 400); }
	const ok = await deleteJoke(x.couple._id, id);
	return ok ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
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

// Daily "answer the question" nudge at 20:00 local (Duolingo of love).
startScheduler();

export default { port, hostname: "0.0.0.0", fetch: app.fetch };
