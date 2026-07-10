import { getCouplesCollection } from "./db.js";
import { randomBytes } from "crypto";

/**
 * @param {import('mongodb').ObjectId} userId
 */
export async function getCoupleForUser(userId) {
	const couples = await getCouplesCollection();
	return couples.findOne({ "users.userId": userId });
}

/**
 * @param {import('mongodb').ObjectId} userId
 */
export async function createCouple(userId) {
	const couples = await getCouplesCollection();

	// Only one couple allowed in the app — Sempurna is for exactly two people.
	const existing = await couples.findOne({});
	if (existing) return null;

	const inviteCode = randomBytes(12).toString("hex");

	const result = await couples.insertOne({
		users: [{ userId, joinedAt: new Date() }],
		inviteCode,
		createdAt: new Date(),
		nextTrip: null,       // ISO date of the next time together (Us tab countdown)
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
