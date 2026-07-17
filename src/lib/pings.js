import { getPingsCollection } from "./db.js";

/** The ping vocabulary — spam gained a language. */
export const PING_TYPES = {
	thinking: { emoji: "💗", single: "is thinking of you 💗" },
	kiss:     { emoji: "😘", single: "sent you a kiss 😘" },
	hug:      { emoji: "🫂", single: "wrapped you in a hug 🫂" },
	miss:     { emoji: "🥺", single: "misses you so much 🥺" },
	angry:    { emoji: "😤", single: "says ANSWER YOUR PHONE 😤" },
	spicy:    { emoji: "🌶️", single: "is having thoughts about you 🌶️😏" },
};

/**
 * @param {import('mongodb').ObjectId} coupleId
 * @param {import('mongodb').ObjectId} fromUserId
 * @param {string} [type] one of PING_TYPES (default "thinking")
 */
export async function sendPing(coupleId, fromUserId, type = "thinking") {
	const clean = PING_TYPES[type] ? type : "thinking";
	await (await getPingsCollection()).insertOne({
		coupleId,
		fromUserId,
		type: clean,
		createdAt: new Date(),
	});
	return clean;
}

/** Flavor of the most recent ping from this sender (for the incoming rain). */
export async function lastPingType(coupleId, fromUserId) {
	const latest = await (await getPingsCollection()).findOne(
		{ coupleId, fromUserId },
		{ sort: { createdAt: -1 }, projection: { type: 1 } },
	);
	return latest?.type || "thinking";
}

/** Pings sent by this user in the last `windowMs` — sizes the burst. */
export async function burstCount(coupleId, fromUserId, windowMs = 60_000) {
	return (await getPingsCollection()).countDocuments({
		coupleId,
		fromUserId,
		createdAt: { $gt: new Date(Date.now() - windowMs) },
	});
}

/**
 * The escalating notification for a burst. One collapse-id per sender →
 * the lock screen shows a single notification counting up live.
 */
export function burstMessage(name, type, count) {
	const t = PING_TYPES[type] || PING_TYPES.thinking;
	if (count <= 1) return { title: "Sempurna 💌", body: `${name} ${t.single}` };
	if (count < 10) return { title: "Sempurna 💌", body: `${name} ${t.single.replace(/ .*$/, "")}… ×${count} ${t.emoji}` };
	if (count < 25) return { title: `${name} ×${count} ${t.emoji}`, body: `That's a lot of love incoming 😳` };
	if (count < 50) return { title: `${name} can't stop ×${count} 🔥`, body: `Your phone is basically on fire` };
	return { title: `SEND HELP ×${count} 🔥${t.emoji}🔥`, body: `${name} has completely lost it (in a cute way)` };
}

/**
 * Sent/received counts since local midnight — the client passes its own UTC
 * offset so "today" means the holder's day, not the server's.
 * @param {import('mongodb').ObjectId} coupleId
 * @param {import('mongodb').ObjectId} meId
 * @param {number} tzOffsetMinutes minutes east of UTC (e.g. Paris DST = 120, Makassar = 480)
 */
export async function todayCounts(coupleId, meId, tzOffsetMinutes = 0) {
	const now = Date.now();
	const local = new Date(now + tzOffsetMinutes * 60_000);
	local.setUTCHours(0, 0, 0, 0);
	const midnight = new Date(local.getTime() - tzOffsetMinutes * 60_000);

	const col = await getPingsCollection();
	const [sent, received] = await Promise.all([
		col.countDocuments({ coupleId, fromUserId: meId, createdAt: { $gte: midnight } }),
		col.countDocuments({ coupleId, fromUserId: { $ne: meId }, createdAt: { $gte: midnight } }),
	]);
	return { sent, received };
}
