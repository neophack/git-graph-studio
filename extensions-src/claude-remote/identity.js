"use strict";
/* The PC's identity on a relay: one user id + agent secret + pairing key K + epoch,
 * shared by every window of this editor (the secret storage is per-install, not
 * per-window — that sharing IS the "one PC, one QR" rule of the plan).
 *
 * First creation races between windows: the global state stands in for the lock file
 * (claim → read-back → publish; a stale claim past its expiry is taken over), so exactly
 * one window registers and the others read what it published. A rekey mints a fresh K,
 * bumps the relay's epoch — every paired phone is kicked and must scan the new QR — and
 * the shared identity carries the new material to this PC's other windows at once. */

const crypto = require("./crypto.js");

const IDENTITY_KEY = "claude-remote.identity";
const LOCK_KEY = "claude-remote.identity.lock";
const LOCK_STALE_MS = 2 * 60 * 1000;
const PUBLISH_WAIT_MS = 30 * 1000;

/** Normalize a relay address: no trailing slash; a bare host gets https (a LAN relay on
 *  plain HTTP must say so — `http://nas.local:8787`). */
function normalizeServer(url) {
	const raw = String(url || "").trim().replace(/\/+$/, "");
	if (!raw) return null;
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
	try {
		const parsed = new URL(withScheme);
		return parsed.origin;
	} catch {
		return null;
	}
}

/** The QR/link a phone pairs by: `https://<relay>/c/<user>#p.<auth>.<epoch>` — the
 *  pairing credential (hex HKDF(K, "crr1/auth"), what the relay stored at registration)
 *  rides the URL fragment, which no browser ever sends to a server on its own. The
 *  phone hands it to `/api/v1/pair` as `secret` — no browser crypto involved while the
 *  frames are plain (wire.js). */
function linkUrl(serverUrl, userId, K, epoch) {
	const auth = crypto.deriveAuth(crypto.keyMaterial(K)).toString("hex");
	return `${normalizeServer(serverUrl)}/c/${userId}#p.${auth}.${epoch}`;
}

/** What the fragments of a pairing link carry, parsed back; null when malformed. */
function parseLink(url) {
	try {
		const parsed = new URL(String(url));
		const match = parsed.hash.replace(/^#/, "").match(/^p\.([0-9a-f]{64})\.(\d+)$/);
		if (!match || !/^\/c\/[\w-]+$/.test(parsed.pathname)) return null;
		return { serverUrl: parsed.origin, auth: match[1], epoch: Number(match[2]), userId: parsed.pathname.split("/").pop() };
	} catch {
		return null;
	}
}

/* ---------- the relay's REST surface ---------- */

async function relayFetch(serverUrl, method, path, { agentSecret, body, timeoutMs = 20000 } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(`${normalizeServer(serverUrl)}${path}`, {
			method,
			headers: {
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				...(agentSecret ? { Authorization: `Bearer ${agentSecret}` } : {})
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal
		});
		const text = await response.text();
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		return { status: response.status, ok: response.ok, json };
	} catch (error) {
		const reason = error && error.name === "AbortError" ? "timed out" : String((error && error.message) || error);
		throw new Error(`the relay at ${normalizeServer(serverUrl)}: ${reason}`);
	} finally {
		clearTimeout(timer);
	}
}

/** Register this PC on a relay (plan §3.4): a fresh K, its derived auth credential, and
 *  the relay's answer — the user id and the agent secret every window proves with. */
async function register(serverUrl, { invite, log } = {}) {
	const K = crypto.randomBytes(32);
	const auth = crypto.deriveAuth(K);
	// The identity keeps K in its base64url spelling — the JSON it is stored in never
	// keeps a Buffer honest, and every consumer (link, relay, phone) wants the string. 
	const { status, ok, json } = await relayFetch(serverUrl, "POST", "/api/v1/register", {
		body: { auth: auth.toString("hex"), ...(invite ? { token: invite } : {}) }
	});
	if (!ok) {
		const reason = json && json.error ? json.error : `HTTP ${status}`;
		const hint = status === 401 && /token/i.test(String(reason)) ? " (the relay needs its registration token)" : "";
		throw new Error(`registering on the relay failed: ${reason}${hint}`);
	}
	if (log) log(`registered on ${normalizeServer(serverUrl)} as ${json.user_id}`);
	return { serverUrl: normalizeServer(serverUrl), userId: json.user_id, agentSecret: json.agent_secret, K: crypto.b64url(K), epoch: Number(json.epoch) || 1 };
}

/** Mint a fresh pairing key and move the relay's epoch: every phone is kicked, this PC's
 *  other windows reload the identity (the relay tells them `epoch_changed`). */
async function rekey(identity) {
	const K = crypto.randomBytes(32);
	const auth = crypto.deriveAuth(K);
	const { status, ok, json } = await relayFetch(identity.serverUrl, "PUT", "/api/v1/me/pairing", {
		agentSecret: identity.agentSecret,
		body: { auth: auth.toString("hex"), expect_epoch: identity.epoch }
	});
	if (!ok) {
		const reason = json && json.error ? json.error : `HTTP ${status}`;
		const error = new Error(status === 409 ? "another window rekeyed first — reloading the identity" : `rekeying failed: ${reason}`);
		// The HTTP status rides along: 401 means the relay no longer knows this PC at
		// all (its data was reset) — the caller's cue to register fresh, not to retry.
		error.status = status;
		throw error;
	}
	return { ...identity, K: crypto.b64url(K), epoch: Number(json.epoch) || identity.epoch + 1 };
}

/** Forget the stored identity — the recovery half of a relay that was reset from empty
 *  data: the next load registers this PC fresh (a new user id and QR). */
async function forget(context) {
	try { await context.secrets.delete(IDENTITY_KEY); } catch { /* no secret storage, or no delete */ }
	try { await context.globalState.update(IDENTITY_KEY, undefined); } catch { /* nothing stored */ }
}

/** Whether the relay still knows this PC's credential: true it does, false it does not
 *  (register fresh), null when the relay was unreachable (the ordinary offline retry —
 *  never a cue to throw the identity away). */
async function check(identity) {
	let answer;
	try {
		answer = await relayFetch(identity.serverUrl, "GET", "/api/v1/me/devices", { agentSecret: identity.agentSecret, timeoutMs: 8000 });
	} catch {
		return null;
	}
	return answer.ok;
}

async function setPassword(identity, password) {
	const { status, ok, json } = await relayFetch(identity.serverUrl, "PUT", "/api/v1/me/password", {
		agentSecret: identity.agentSecret,
		body: { password }
	});
	if (!ok) throw new Error(`setting the login password failed: ${(json && json.error) || `HTTP ${status}`}`);
}

async function clearPassword(identity) {
	const { status, ok, json } = await relayFetch(identity.serverUrl, "DELETE", "/api/v1/me/password", {
		agentSecret: identity.agentSecret
	});
	if (!ok) throw new Error(`clearing the login password failed: ${(json && json.error) || `HTTP ${status}`}`);
}

/** The paired phones plus the login-password gate's state (the panel shows both). */
async function devices(identity) {
	const { ok, json } = await relayFetch(identity.serverUrl, "GET", "/api/v1/me/devices", {
		agentSecret: identity.agentSecret
	});
	return {
		devices: ok && Array.isArray(json && json.devices) ? json.devices : [],
		passwordSet: !!(ok && json && json.password_set)
	};
}

/** This PC's online windows as the relay routes them — sealed `meta_ct` blobs, opaque to
 *  the relay and to this call; the caller decrypts with the frame key. */
async function windows(identity) {
	const { ok, json } = await relayFetch(identity.serverUrl, "GET", "/api/v1/me/windows", {
		agentSecret: identity.agentSecret
	});
	return ok && Array.isArray(json && json.windows) ? json.windows : [];
}

async function revokeDevice(identity, deviceId) {
	const { ok, json } = await relayFetch(identity.serverUrl, "DELETE", `/api/v1/me/devices/${encodeURIComponent(deviceId)}`, {
		agentSecret: identity.agentSecret
	});
	if (!ok) throw new Error(`revoking the device failed: ${(json && json.error) || ""}`);
}

async function rotateAgentSecret(identity) {
	const { ok, json } = await relayFetch(identity.serverUrl, "POST", "/api/v1/me/rotate-agent-secret", {
		agentSecret: identity.agentSecret
	});
	if (!ok) throw new Error("rotating the agent secret failed");
	return json.agent_secret;
}

async function unregister(identity) {
	await relayFetch(identity.serverUrl, "DELETE", "/api/v1/me", { agentSecret: identity.agentSecret });
}

/* ---------- the identity store (secrets + the creation lock) ---------- */

function validIdentity(value) {
	return !!value
		&& typeof value === "object"
		&& /^u_[0-9a-z]{16,}$/.test(String(value.userId))
		&& /^[0-9a-f]{64}$/.test(String(value.agentSecret))
		&& /^[A-Za-z0-9_-]{43}$/.test(String(value.K)) // base64url of 32 bytes, unpadded
		&& Number.isFinite(Number(value.epoch))
		&& !!normalizeServer(value.serverUrl);
}

/** Read the stored identity, or create one — the lock keeps N simultaneously starting
 *  windows to exactly one registration (the others adopt what the winner published). */
async function load(context, { serverUrl, invite, log } = {}) {
	const wanted = normalizeServer(serverUrl);
	const stored = await readIdentity(context);
	if (stored && (!wanted || stored.serverUrl === wanted)) return stored;
	if (stored && wanted && stored.serverUrl !== wanted) {
		// A different relay: a fresh identity there (the old one stays on the old relay
		// until its PC is deleted from it — nothing here can reach it).
		const fresh = await claimOrCreate(context, { serverUrl: wanted, invite, log });
		return fresh;
	}
	return claimOrCreate(context, { serverUrl: wanted, invite, log });
}

async function readIdentity(context) {
	let raw = null;
	try {
		raw = await context.secrets.get(IDENTITY_KEY);
	} catch { /* no secret storage */ }
	const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
	if (validIdentity(parsed)) return parsed;
	const fallback = context.globalState.get(IDENTITY_KEY);
	return validIdentity(fallback) ? fallback : null;
}

async function writeIdentity(context, identity) {
	const raw = JSON.stringify(identity);
	try {
		await context.secrets.store(IDENTITY_KEY, raw);
		await context.globalState.update(IDENTITY_KEY, undefined);
	} catch {
		// hosts without secret storage — the fallback keeps the extension usable, loudly
		await context.globalState.update(IDENTITY_KEY, identity);
	}
}

async function claimOrCreate(context, { serverUrl, invite, log }) {
	const owner = Math.random().toString(36).slice(2, 10);
	const now = Date.now();
	const existing = context.globalState.get(LOCK_KEY);
	if (!existing || !existing.owner || now - Number(existing.at || 0) > LOCK_STALE_MS) {
		await context.globalState.update(LOCK_KEY, { owner, at: now });
		await new Promise((resolve) => setTimeout(resolve, 60)); // the other claimants' write lands
		const readBack = context.globalState.get(LOCK_KEY);
		if (readBack === undefined) {
			// Our own write is invisible: the state storage is not answering, and the
			// lock protocol cannot work on it — fail loudly instead of waiting forever.
			throw new Error("the editor's global state storage is not answering; the identity lock cannot be taken");
		}
		if (!readBack || readBack.owner !== owner) {
			// Lost the race: the winner publishes the identity; wait it out.
			const adopted = await waitForPublish(context, log);
			if (adopted) return adopted;
			return claimOrCreate(context, { serverUrl, invite, log }); // the claim went stale — go again
		}
		try {
			if (!serverUrl) throw new Error("no relay is configured — set claudeRemote.serverUrl (the panel asks for it)");
			const identity = await register(serverUrl, { invite, log });
			await writeIdentity(context, identity);
			return identity;
		} finally {
			if (context.globalState.get(LOCK_KEY)?.owner === owner) await context.globalState.update(LOCK_KEY, undefined);
		}
	}
	const adopted = await waitForPublish(context, log);
	if (adopted) return adopted;
	return claimOrCreate(context, { serverUrl, invite, log });
}

async function waitForPublish(context, log) {
	const deadline = Date.now() + PUBLISH_WAIT_MS;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 250));
		const published = await readIdentity(context);
		if (published) return published;
	}
	if (log) log("another window is registering this PC on the relay — it did not publish in time");
	return null;
}

/** Adopt material another window rekeyed to (the relay's `epoch_changed` lands there). */
async function adopt(context, identity) {
	await writeIdentity(context, identity);
	return identity;
}

/** The link a phone pairs by, for the identity as it stands. */
function link(identity) {
	return linkUrl(identity.serverUrl, identity.userId, identity.K, identity.epoch);
}

module.exports = {
	IDENTITY_KEY,
	normalizeServer,
	linkUrl,
	parseLink,
	link,
	load,
	readIdentity,
	writeIdentity,
	adopt,
	register,
	rekey,
	forget,
	check,
	setPassword,
	clearPassword,
	devices,
	windows,
	revokeDevice,
	rotateAgentSecret,
	unregister,
	relayFetch,
	validIdentity
};
