import { getPingsCollection } from "./db.js";

/**
 * @param {import('mongodb').ObjectId} coupleId
 * @param {import('mongodb').ObjectId} fromUserId
 */
export async function sendPing(coupleId, fromUserId) {
	await (await getPingsCollection()).insertOne({
		coupleId,
		fromUserId,
		createdAt: new Date(),
	});
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
