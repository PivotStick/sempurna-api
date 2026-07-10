import { getWordsCollection } from "./db.js";

/**
 * The shared Bahasa↔Français dictionary (Kamus tab).
 * @param {import('mongodb').ObjectId} coupleId
 */
export async function listWords(coupleId) {
	return (await getWordsCollection()).find({ coupleId }).sort({ createdAt: -1 }).toArray();
}

/**
 * @param {import('mongodb').ObjectId} coupleId
 * @param {import('mongodb').ObjectId} addedBy
 * @param {{ indonesian: string, french: string, english: string, note?: string }} input
 */
export async function addWord(coupleId, addedBy, { indonesian, french, english, note }) {
	const doc = {
		coupleId,
		addedBy,
		indonesian,
		french,
		english,
		note: note || "",
		createdAt: new Date(),
	};
	await (await getWordsCollection()).insertOne(doc);
	return doc;
}

/** Either partner can delete — it's their shared dictionary. */
export async function deleteWord(coupleId, wordId) {
	const { deletedCount } = await (await getWordsCollection()).deleteOne({ coupleId, _id: wordId });
	return deletedCount > 0;
}
