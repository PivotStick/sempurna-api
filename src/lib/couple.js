import { getCouplesCollection } from "./db.js";
import { randomBytes } from "crypto";

/**
 * @param {import('mongodb').ObjectId} userId
 */
export async function getCoupleForUser(userId) {
	const couples = await getCouplesCollection();
	return couples.findOne({ "users.userId": userId });
}

/** Is this a usable IANA timezone? */
function validTimeZone(tz) {
	try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return true; }
	catch { return false; }
}

/**
 * The couple's canonical "today" (YYYY-MM-DD). One shared day per couple —
 * living 6-7 hours apart, per-user local days would give each partner a
 * different daily question every night. The day flips at midnight in the
 * creator's timezone (Paris 00:00 = 06:00 in Makassar: both asleep-ish).
 */
export function coupleDayString(couple, now = new Date()) {
	const tz = validTimeZone(couple?.dayTimeZone) ? couple.dayTimeZone : "Europe/Paris";
	return now.toLocaleDateString("en-CA", { timeZone: tz });
}

/**
 * @param {import('mongodb').ObjectId} userId
 * @param {string} [dayTimeZone] IANA tz of the creator — anchors the couple's shared day
 */
export async function createCouple(userId, dayTimeZone) {
	const couples = await getCouplesCollection();

	// Only one couple allowed in the app — Sempurna is for exactly two people.
	const existing = await couples.findOne({});
	if (existing) return null;

	const inviteCode = randomBytes(12).toString("hex");

	const result = await couples.insertOne({
		users: [{ userId, joinedAt: new Date() }],
		inviteCode,
		createdAt: new Date(),
		dayTimeZone: validTimeZone(dayTimeZone) ? dayTimeZone : "Europe/Paris",
		nextTrip: null,       // ISO date of the next time together (Us tab countdown)
		streak: 0,            // consecutive days with both answers (fuels spicy mode)
		longestStreak: 0,
		lastCompletedDate: null,
	});

	return { _id: result.insertedId, inviteCode };
}

/**
 * @param {string} inviteCode
 * @param {import('mongodb').ObjectId} userId
 */
export async function joinCouple(inviteCode, userId) {
	const couples = await getCouplesCollection();
	const couple = await couples.findOne({ inviteCode });

	if (!couple) return null;
	if (couple.users.length >= 2) return null;
	if (couple.users.some((/** @type {any} */ u) => u.userId.equals(userId))) return null;

	await couples.updateOne(
		{ _id: couple._id },
		{ $push: { users: { userId, joinedAt: new Date() } } },
	);

	return couple._id;
}

/**
 * Both partners answered today's question — advance the streak.
 * @param {import('mongodb').ObjectId} coupleId
 * @param {string} todayStr
 */
export async function completeDay(coupleId, todayStr) {
	const couples = await getCouplesCollection();
	const couple = await couples.findOne({ _id: coupleId });
	if (!couple || couple.lastCompletedDate === todayStr) return;

	const yesterday = (() => {
		const d = new Date(todayStr + "T00:00:00Z");
		d.setUTCDate(d.getUTCDate() - 1);
		return d.toISOString().slice(0, 10);
	})();

	const streak = couple.lastCompletedDate === yesterday ? (couple.streak || 0) + 1 : 1;
	await couples.updateOne(
		{ _id: coupleId },
		{ $set: {
			streak,
			longestStreak: Math.max(couple.longestStreak || 0, streak),
			lastCompletedDate: todayStr,
		} },
	);
}

/**
 * @param {import('mongodb').ObjectId} coupleId
 * @param {string|null} dateStr YYYY-MM-DD or null to clear
 */
export async function setNextTrip(coupleId, dateStr) {
	if (dateStr !== null && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
		return { ok: false, error: "invalid_date" };
	}
	const couples = await getCouplesCollection();
	await couples.updateOne({ _id: coupleId }, { $set: { nextTrip: dateStr } });
	return { ok: true };
}
