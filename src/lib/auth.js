import { getUsers, getSessions } from "./db.js";
import { randomBytes, scryptSync, timingSafeEqual } from "crypto";

const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MAX_USERS = 2; // it's a couple app — the first two accounts are the only two

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

async function createSession(userId) {
	const token = randomBytes(32).toString("hex");
	await (await getSessions()).insertOne({
		token,
		userId,
		expiresAt: new Date(Date.now() + SESSION_TTL_MS),
	});
	return token;
}

/**
 * Create an account (sempurna's own users collection — no shared auth).
 * Registration closes itself once the couple is complete.
 * @returns {Promise<{ token: string, user: object } | { error: string }>}
 */
export async function register(username, password) {
	if (!username || !/^[a-z0-9_.-]{2,24}$/i.test(username)) return { error: "invalid_username" };
	if (!password || password.length < 6) return { error: "password_too_short" };

	const users = await getUsers();
	if ((await users.countDocuments({})) >= MAX_USERS) return { error: "couple_full" };
	if (await users.findOne({ username })) return { error: "username_taken" };

	const salt = randomBytes(16).toString("hex");
	const doc = {
		username,
		password: `${salt}:${hashPassword(password, salt)}`,
		createdAt: new Date(),
	};
	const { insertedId } = await users.insertOne(doc);
	return { token: await createSession(insertedId), user: { _id: insertedId, ...doc } };
}

/** Validate credentials, create a session, and return the bearer token + user. */
export async function login(username, password) {
	if (!username || !password) return null;
	const users = await getUsers();
	const user = await users.findOne({ username });
	if (!user || !verifyPassword(password, user.password)) return null;
	return { token: await createSession(user._id), user };
}

/** Look up the user for a bearer token. */
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
