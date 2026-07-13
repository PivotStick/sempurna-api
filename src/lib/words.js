import { ObjectId } from "mongodb";
import { getWordsCollection } from "./db.js";
import { putObject, deleteObject, publicUrl } from "./r2.js";

const MAX_VOICE_BYTES = 2 * 1024 * 1024; // ~30s of mono AAC is well under this

/**
 * The shared Bahasa↔Français dictionary (Kamus tab).
 * @param {import('mongodb').ObjectId} coupleId
 */
export async function listWords(coupleId) {
	return (await getWordsCollection()).find({ coupleId }).sort({ createdAt: -1 }).toArray();
}

/**
 * A word now carries its text per language code — whatever pair of languages
 * the couple speaks: { texts: { id: "Sayangku", fr: "Mon amour" }, note }.
 * @param {import('mongodb').ObjectId} coupleId
 * @param {import('mongodb').ObjectId} addedBy
 * @param {{ texts: Record<string, string>, note?: string }} input
 */
export async function addWord(coupleId, addedBy, { texts, note }) {
	const clean = {};
	for (const [code, value] of Object.entries(texts || {})) {
		if (/^[a-z]{2,3}$/i.test(code) && typeof value === "string" && value.trim()) {
			clean[code.toLowerCase()] = value.trim();
		}
	}
	if (Object.keys(clean).length < 2) return null;   // both sides of the pair, please

	const doc = {
		coupleId,
		addedBy,
		texts: clean,
		note: (note || "").trim(),
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

// MARK: Voice notes — hear each other pronounce the words 🎙️

/**
 * Attach a pronunciation to a word. Audio is an m4a, stored on R2.
 * @param {import('mongodb').ObjectId} coupleId
 * @param {import('mongodb').ObjectId} wordId
 * @param {import('mongodb').ObjectId} addedBy
 * @param {{ audioBase64: string, duration?: number }} input
 * @returns updated word doc, or { error }
 */
export async function addVoice(coupleId, wordId, addedBy, { audioBase64, duration }) {
	const words = await getWordsCollection();
	const word = await words.findOne({ coupleId, _id: wordId });
	if (!word) return { error: "not_found" };

	const bytes = Buffer.from(audioBase64 || "", "base64");
	if (!bytes.length || bytes.length > MAX_VOICE_BYTES) return { error: "audio_invalid" };

	const voiceId = new ObjectId();
	const key = `voices/${wordId.toString()}/${voiceId.toString()}.m4a`;
	await putObject(key, bytes, "audio/mp4");

	const voice = {
		_id: voiceId,
		addedBy,
		key,
		url: publicUrl(key),
		duration: Math.max(0, Math.round(Number(duration) || 0)),
		createdAt: new Date(),
	};
	const updated = await words.findOneAndUpdate(
		{ _id: wordId },
		{ $push: { voices: voice } },
		{ returnDocument: "after" },
	);
	return { word: updated };
}

/** Delete one of your own pronunciations (R2 file included, best-effort). */
export async function deleteVoice(coupleId, wordId, voiceId, userId) {
	const words = await getWordsCollection();
	const word = await words.findOne({ coupleId, _id: wordId });
	const voice = (word?.voices || []).find((v) => v._id.equals(voiceId));
	if (!voice) return null;
	if (!voice.addedBy.equals(userId)) return null;   // your voice, your call — only yours

	await deleteObject(voice.key).catch(() => {});
	return words.findOneAndUpdate(
		{ _id: wordId },
		{ $pull: { voices: { _id: voiceId } } },
		{ returnDocument: "after" },
	);
}
