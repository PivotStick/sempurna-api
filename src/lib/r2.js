// Cloudflare R2 (S3-compatible) via Bun's built-in S3 client — no extra dependency.
// Credentials come from env (shared pivotass-anki bucket): R2_ACCOUNT_ID,
// R2_BUCKET_NAME, R2_ACCESS_KEY, R2_SECRET, R2_PUBLIC_URL.
import { S3Client } from "bun";

let client = null;

function getClient() {
	if (!client) {
		if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID) {
			throw new Error("R2 storage is not configured (missing R2_* env vars)");
		}
		client = new S3Client({
			accessKeyId: process.env.R2_ACCESS_KEY_ID,
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
			bucket: process.env.R2_BUCKET_NAME,
			endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		});
	}
	return client;
}

/** @param {string} key @param {Uint8Array|ArrayBuffer|Buffer} body @param {string} contentType */
export async function putObject(key, body, contentType) {
	await getClient().write(key, body, { type: contentType });
	return key;
}

/** @param {string} key */
export async function deleteObject(key) {
	await getClient().delete(key);
}

/** @param {string[]} keys */
export async function deleteObjects(keys) {
	const c = getClient();
	for (const k of keys) {
		try { await c.delete(k); } catch { /* best-effort */ }
	}
}

/** @param {string} _prefix — not needed yet */
export async function deleteByPrefix(_prefix) {}

/** @param {string} key */
export function publicUrl(key) {
	return process.env.R2_PUBLIC_URL ? `${process.env.R2_PUBLIC_URL}/${key}` : key;
}
