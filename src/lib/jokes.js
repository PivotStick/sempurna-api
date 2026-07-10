import { getJokesCollection } from "./db.js";

/**
 * The inside-jokes encyclopedia. Every joke has an origin story — we keep them all.
 * @param {import('mongodb').ObjectId} coupleId
 */
export async function listJokes(coupleId) {
	return (await getJokesCollection()).find({ coupleId }).sort({ date: -1 }).toArray();
}

/**
 * @param {import('mongodb').ObjectId} coupleId
 * @param {import('mongodb').ObjectId} addedBy
 * @param {{ title: string, emoji?: string, story: string, date?: string }} input
 *        `date` (YYYY-MM-DD) = when the joke was born; defaults to today.
 */
export async function addJoke(coupleId, addedBy, { title, emoji, story, date }) {
	const born = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? new Date(date + "T12:00:00Z") : new Date();
	const doc = {
		coupleId,
		addedBy,
		title,
		emoji: emoji || "😂",
		story,
		date: born,
		createdAt: new Date(),
	};
	await (await getJokesCollection()).insertOne(doc);
	return doc;
}

/** Either partner can delete — it's their shared book. */
export async function deleteJoke(coupleId, jokeId) {
	const { deletedCount } = await (await getJokesCollection()).deleteOne({ coupleId, _id: jokeId });
	return deletedCount > 0;
}
