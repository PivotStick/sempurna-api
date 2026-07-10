import { getPresencesCollection } from "./db.js";

/**
 * One presence doc per user — city, flag and timezone from the device's
 * geolocation. A new location simply overwrites the previous one.
 * @param {import('mongodb').ObjectId} userId
 * @param {{ city: string, flag: string, timeZoneID: string }} input
 */
export async function upsertPresence(userId, { city, flag, timeZoneID }) {
	await (await getPresencesCollection()).updateOne(
		{ userId },
		{ $set: { userId, city, flag: flag || "📍", timeZoneID, updatedAt: new Date() } },
		{ upsert: true },
	);
}

/**
 * @param {import('mongodb').ObjectId[]} userIds
 */
export async function getPresences(userIds) {
	return (await getPresencesCollection()).find({ userId: { $in: userIds } }).toArray();
}
