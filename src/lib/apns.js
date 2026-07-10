// Low-level APNs sender — token-based auth (.p8 ES256 JWT) over HTTP/2.
// Gracefully no-ops when not configured, so the app keeps working without push set up.
//
// Env:
//   APNS_KEY_ID     – the 10-char Key ID of the APNs auth key
//   APNS_TEAM_ID    – Apple Developer team id (MP3U3QZXJL)
//   APNS_KEY        – the .p8 contents (PEM, \n-escaped) — or APNS_KEY_PATH to a file
//   APNS_BUNDLE_ID  – defaults to com.maxime.sempurna
//   APNS_ENV        – "production" (TestFlight/App Store) or "sandbox" (dev device builds)
import http2 from "node:http2";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const KEY_ID = process.env.APNS_KEY_ID;
const TEAM_ID = process.env.APNS_TEAM_ID;
const BUNDLE_ID = process.env.APNS_BUNDLE_ID || "com.maxime.sempurna";
const ENV = process.env.APNS_ENV === "sandbox" ? "sandbox" : "production";
const HOST = ENV === "sandbox"
	? "https://api.sandbox.push.apple.com"
	: "https://api.push.apple.com";

// Normalize an env-provided private key into clean PEM. Tolerates the many ways a .p8
// gets mangled in env editors: surrounding quotes, literal "\n", and backslash
// line-continuations ("\" + a real newline).
function normalizePem(raw) {
	if (!raw) return null;
	let k = raw.trim();
	if (k.length >= 2 && ((k[0] === '"' && k.at(-1) === '"') || (k[0] === "'" && k.at(-1) === "'"))) {
		k = k.slice(1, -1);
	}
	k = k
		.replace(/\\\r?\n/g, "\n")   // backslash-continuation → real newline
		.replace(/\\n/g, "\n")        // literal "\n" → real newline
		.replace(/\\r/g, "")
		.trim();
	return k + "\n";
}

function privateKeyPem() {
	if (process.env.APNS_KEY) return normalizePem(process.env.APNS_KEY);
	if (process.env.APNS_KEY_PATH) {
		try { return readFileSync(process.env.APNS_KEY_PATH, "utf8"); } catch { return null; }
	}
	return null;
}

export function isConfigured() {
	return !!(KEY_ID && TEAM_ID && privateKeyPem());
}

const b64url = (s) => Buffer.from(s).toString("base64url");

// APNs auth JWT — valid up to 1h; cache and refresh well before that.
let cachedToken = null;
let cachedAtSec = 0;
function authToken() {
	const nowSec = Math.floor(Date.now() / 1000);
	if (cachedToken && nowSec - cachedAtSec < 3000) return cachedToken;
	const header = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID }));
	const payload = b64url(JSON.stringify({ iss: TEAM_ID, iat: nowSec }));
	const signingInput = `${header}.${payload}`;
	const key = createPrivateKey(privateKeyPem());
	// ieee-p1363 → the raw r||s JOSE signature APNs expects (not DER).
	const sigB64 = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" })
		.toString("base64url");
	cachedToken = `${signingInput}.${sigB64}`;
	cachedAtSec = nowSec;
	return cachedToken;
}

let client = null;
function getClient() {
	if (!client || client.destroyed || client.closed) {
		client = http2.connect(HOST);
		client.on("error", () => { client = null; });
		client.on("goaway", () => { client = null; });
	}
	return client;
}

/**
 * Send one push. Resolves to { status, reason } (or null if unconfigured / transport error).
 * @param {string} deviceToken hex device token
 * @param {object} payload full APNs payload (must include `aps`)
 */
export async function sendPush(deviceToken, payload, opts = {}) {
	if (!isConfigured()) {
		console.log("[apns] not configured — skipping push");
		return null;
	}
	const pushType = opts.pushType || "alert";
	// Live Activity updates use a dedicated topic suffix.
	const topic = pushType === "liveactivity" ? `${BUNDLE_ID}.push-type.liveactivity` : BUNDLE_ID;
	return new Promise((resolve) => {
		let settled = false;
		const done = (v) => { if (!settled) { settled = true; resolve(v); } };
		try {
			const headers = {
				":method": "POST",
				":path": `/3/device/${deviceToken}`,
				"authorization": `bearer ${authToken()}`,
				"apns-topic": topic,
				"apns-push-type": pushType,
				"content-type": "application/json",
			};
			if (opts.priority) headers["apns-priority"] = String(opts.priority);
			const req = getClient().request(headers);
			let status = 0;
			let data = "";
			req.setTimeout(8000, () => { req.close(); done(null); });
			req.on("response", (h) => { status = h[":status"]; });
			req.on("data", (d) => { data += d; });
			req.on("end", () => {
				let reason;
				try { reason = JSON.parse(data || "{}").reason; } catch {}
				done({ status, reason });
			});
			req.on("error", (e) => { console.log("[apns] request error:", e.message); done(null); });
			req.end(JSON.stringify(payload));
		} catch (e) {
			console.log("[apns] send failed:", e.message);
			done(null);
		}
	});
}
