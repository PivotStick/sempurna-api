import { ObjectId } from "mongodb";
import { getMomentsCollection } from "./db.js";
import { putObject, publicUrl } from "./r2.js";

const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // the iOS client sends ≤1200px JPEGs, well under this

/**
 * Create a moment; `photoBase64` (optional) is stored on R2 under sempurna/.
 * @param {import('mongodb').ObjectId} coupleId
 * @param {import('mongodb').ObjectId} fromUserId
 * @param {{ note: string, emoji: string, paletteIndex: number, photoBase64?: string }} input
 */
export async function createMoment(coupleId, fromUserId, { note, emoji, paletteIndex, photoBase64 }) {
	const _id = new ObjectId();

	let photoUrl = null;
	if (photoBase64) {
		const bytes = Buffer.from(photoBase64, "base64");
		if (!bytes.length || bytes.length > MAX_PHOTO_BYTES) return { ok: false, error: "photo_too_big" };
		const key = `sempurna/moments/${_id.toString()}.jpg`;
		await putObject(key, bytes, "image/jpeg");
		photoUrl = publicUrl(key);
	}

	const doc = {
		_id,
		coupleId,
		fromUserId,
		note,
		emoji: emoji || "❤️",
		paletteIndex: Number.isInteger(paletteIndex) ? paletteIndex : 0,
		photoUrl,
		createdAt: new Date(),
	};
	await (await getMomentsCollection()).insertOne(doc);
	return { ok: true, moment: doc };
}

/**
 * @param {import('mongodb').ObjectId} coupleId
 */
export async function listMoments(coupleId, limit = 50) {
	return (await getMomentsCollection())
		.find({ coupleId })
		.sort({ createdAt: -1 })
		.limit(limit)
		.toArray();
}
