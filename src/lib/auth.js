import { getUsers, getSessions } from "./db.js";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/** @param {string} password @param {string} salt */
function hashPassword(password, salt) {
	return scryptSync(password, salt, 64).toString("hex");
}

/** Verify a "salt:hash" stored password (scrypt + timing-safe compare). */
export function verifyPassword(password, stored) {
	if (typeof stored !== "string" || !stored.includes(":")) return false;
	const [salt, hash] = stored.split(":");
	const attempt = hashPassword(password, salt);
	const a = Buffer.from(hash, "hex");
	const b = Buffer.from(attempt, "hex");
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Validate credentials against pivotauth, create a session in the shared
 * `sessions` collection, and return the bearer token + user.
 */
export async function login(username, password) {
	if (!username || !password) return null;
	const users = await getUsers();
	const user = await users.findOne({ username });
	if (!user || !verifyPassword(password, user.password)) return null;

	const token = randomBytes(32).toString("hex");
	const sessions = await getSessions();
	await sessions.insertOne({
		token,
		userId: user._id,
		expiresAt: new Date(Date.now() + SESSION_TTL_MS),
	});
	return { token, user };
}

/** Look up the user for a bearer token (same session store as the web app's cookie). */
export async function getUserByToken(token) {
	if (!token) return null;
	const sessions = await getSessions();
	const session = await sessions.findOne({ token, expiresAt: { $gt: new Date() } });
	if (!session) return null;
	const users = await getUsers();
	return users.findOne({ _id: session.userId });
}

export async function deleteSessionToken(token) {
	if (!token) return;
	const sessions = await getSessions();
	await sessions.deleteOne({ token });
}
