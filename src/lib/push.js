// Device-token storage + high-level "notify this user" helper.
import { getDb, getUsers } from "./db.js";
import { sendPush } from "./apns.js";

async function coll() {
	return (await getDb()).collection("device_tokens");
}

export async function registerToken(userId, token, platform = "ios") {
	if (!token) return;
	await (await coll()).updateOne(
		{ token },
		{ $set: { userId, token, platform, updatedAt: new Date() } },
		{ upsert: true },
	);
}

export async function removeToken(token) {
	if (!token) return;
	await (await coll()).deleteOne({ token });
}

export async function tokensForUser(userId) {
	if (!userId) return [];
	const docs = await (await coll()).find({ userId }).toArray();
	return docs.map((d) => d.token);
}

/**
 * Send an alert push to every device of a user. Prunes tokens APNs reports dead.
 * Resolves to the per-device results so callers can surface failures.
 * @param {import('mongodb').ObjectId} userId
 * @param {{ title: string, body: string, data?: object }} message
 */
export async function notifyUser(userId, { title, body, data }) {
	// Per-user mute (the toggle in Profile → Notifications).
	const user = await (await getUsers()).findOne({ _id: userId });
	if (user?.notificationsMuted) return [];

	const tokens = await tokensForUser(userId);
	const results = [];
	for (const token of tokens) {
		const payload = { aps: { alert: { title, body }, sound: "default" } };
		if (data) payload.data = data;
		const res = await sendPush(token, payload);
		if (res && (res.status === 410 || res.reason === "BadDeviceToken" || res.reason === "Unregistered")) {
			await removeToken(token);
		}
		results.push({ token: token.slice(0, 8) + "…", status: res?.status ?? 0, reason: res?.reason });
	}
	return results;
}
