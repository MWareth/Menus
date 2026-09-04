/**
 * Dee's Stock — the server side.
 *
 * One Cloudflare Worker: static files for the app, a small JSON API, and a D1
 * database holding the whole board as one row. The board is small (a few
 * hundred movements a year) so a single JSON document beats a schema here —
 * it keeps the client and the server reading exactly the same shape.
 *
 * Two things the old artifact version could not do, and which are the reason
 * this exists:
 *   - the PIN is checked on the server, so nobody can read the hashes;
 *   - the truck never receives the recipes at all, only the cost totals.
 */

import { SEED } from "./seed.js";

const enc = new TextEncoder();
const DAY = 86400;
const SESSION_DAYS = 30;

/* ============ small helpers ============ */

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* the same salt the board has always used, so existing PIN hashes keep working */
const pinHash = (pin) => sha256Hex("deeserts:" + pin);

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* constant-time compare, so a wrong token cannot be found a character at a time */
function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function cookies(request) {
  const out = {};
  const raw = request.headers.get("cookie") || "";
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

/* ============ the database ============ */

async function ready(env) {
  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS board (id INTEGER PRIMARY KEY, version INTEGER NOT NULL," +
      " json TEXT NOT NULL, updated_at TEXT NOT NULL)"
    ),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  ]);
}

/** The signing key for session cookies. Generated once, on first boot. */
async function sessionSecret(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k = 'session_secret'").first();
  if (row && row.v) return row.v;
  const fresh = crypto.randomUUID() + crypto.randomUUID();
  await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('session_secret', ?)")
    .bind(fresh).run();
  const again = await env.DB.prepare("SELECT v FROM meta WHERE k = 'session_secret'").first();
  return (again && again.v) || fresh;
}

async function loadBoard(env) {
  const row = await env.DB.prepare("SELECT version, json FROM board WHERE id = 1").first();
  if (row) return { version: row.version, state: JSON.parse(row.json) };
  const seeded = JSON.parse(JSON.stringify(SEED));
  await env.DB.prepare(
    "INSERT OR IGNORE INTO board (id, version, json, updated_at) VALUES (1, 1, ?, ?)"
  ).bind(JSON.stringify(seeded), new Date().toISOString()).run();
  return { version: 1, state: seeded };
}

/** Compare-and-set: the write only lands if nobody else has saved meanwhile. */
async function saveBoard(env, expectedVersion, state) {
  const next = expectedVersion + 1;
  const res = await env.DB.prepare(
    "UPDATE board SET version = ?, json = ?, updated_at = ? WHERE id = 1 AND version = ?"
  ).bind(next, JSON.stringify(state), new Date().toISOString(), expectedVersion).run();
  const changed = res.meta && (res.meta.changes || res.meta.rows_written);
  return changed ? next : null;
}

/* ============ sessions ============ */

async function issueSession(env, uid) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * DAY;
  const body = uid + "." + exp;
  const sig = await hmac(await sessionSecret(env), body);
  const value = body + "." + sig;
  return "ds=" + encodeURIComponent(value) + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" +
    SESSION_DAYS * DAY;
}

async function whoAmI(request, env, state) {
  const raw = cookies(request).ds;
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) * 1000 < Date.now()) return null;
  const want = await hmac(await sessionSecret(env), uid + "." + exp);
  if (!sameString(sig, want)) return null;
  return (state.team || []).find((u) => u.id === uid) || null;
}

const ROLES = {
  admin: { canDeliver: true, canSell: true, canSetup: true },
  dees: { canDeliver: true, canSell: false, canSetup: false },
  truck: { canDeliver: false, canSell: true, canSetup: false }
};
const permsOf = (u) => ROLES[u && u.role] || ROLES.truck;

/* ============ what each side is allowed to see ============ */

const sumRecipe = (it) =>
  (it.recipe || []).reduce((a, r) => {
    const q = +r.q, pq = +r.pq, pp = +r.pp;
    return a + (pq > 0 && !isNaN(q) && !isNaN(pp) ? (q / pq) * pp : 0);
  }, 0);

/**
 * The board as this person may see it. PIN hashes never leave the server. The
 * truck gets one synthetic ingredient line carrying the same total, so every
 * cost and margin on their screen is right to the fil while the recipe itself
 * stays behind.
 */
function forViewer(state, me) {
  const view = JSON.parse(JSON.stringify(state));
  view.team = (view.team || []).map((u) => ({ id: u.id, name: u.name, user: u.user, role: u.role }));
  if (!permsOf(me).canDeliver) {
    view.items = (view.items || []).map((it) => ({
      ...it,
      recipe: (it.recipe || []).length
        ? [{ n: "Ingredients", q: 1, u: "", pp: Math.round(sumRecipe(it) * 1e6) / 1e6, pq: 1 }]
        : []
    }));
  }
  return view;
}

/**
 * Merge what the client sent onto what is stored, keeping everything that
 * person is not allowed to touch. The client never has the authority — the
 * stored copy does.
 */
function mergeSave(stored, incoming, me) {
  const perm = permsOf(me);
  const out = JSON.parse(JSON.stringify(stored));

  /* the truck may only record movements against a lot: what sold, what was
     given away, what went in the bin. Nothing else it sends is even read. */
  if (!perm.canDeliver) {
    if (!perm.canSell || !Array.isArray(incoming.batches)) return out;
    const byId = new Map(out.batches.map((b) => [b.id, b]));
    incoming.batches.forEach((b) => {
      const t = byId.get(b && b.id);
      if (t && Array.isArray(b.sales)) {
        t.sales = b.sales
          .filter((s) => s && typeof s.qty === "number" && isFinite(s.qty))
          .map((s) => ({
            qty: s.qty, by: String(s.by || me.id), at: String(s.at || new Date().toISOString()),
            on: typeof s.on === "string" ? s.on : undefined,
            ch: typeof s.ch === "string" ? s.ch : undefined,
            kind: s.kind === "gift" || s.kind === "waste" ? s.kind : undefined,
            fix: s.fix === true ? true : undefined
          }));
      }
    });
    return out;
  }

  /* Dee's side and admins may change the board itself */
  ["currency", "defaultShelf", "notify", "seq", "defaultPins"].forEach((k) => {
    if (incoming[k] !== undefined) out[k] = incoming[k];
  });
  if (incoming.split && typeof incoming.split === "object") out.split = incoming.split;
  if (Array.isArray(incoming.channels)) out.channels = incoming.channels;
  if (Array.isArray(incoming.items)) out.items = incoming.items;
  if (Array.isArray(incoming.batches)) out.batches = incoming.batches;
  if (Array.isArray(incoming.payments)) out.payments = incoming.payments;

  /* the team list is admin-only, and a PIN hash is only ever accepted when the
     client actually sent a fresh one — otherwise the stored hash stands */
  if (perm.canSetup && Array.isArray(incoming.team)) {
    const old = new Map((stored.team || []).map((u) => [u.id, u]));
    out.team = incoming.team.map((u) => {
      const was = old.get(u.id);
      const fresh = typeof u.pin === "string" && /^[0-9a-f]{64}$/.test(u.pin) ? u.pin : null;
      return {
        id: u.id, name: u.name, user: u.user, role: u.role,
        pin: fresh || (was && was.pin) || SEED.defaultPinHash
      };
    });
  } else {
    out.team = stored.team;
  }
  out.updatedAt = new Date().toISOString();
  return out;
}

/* ============ the API ============ */

async function api(request, env, path) {
  await ready(env);
  const board = await loadBoard(env);
  const me = await whoAmI(request, env, board.state);

  if (path === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const who = String(body.user || "").trim().toLowerCase();
    const pin = String(body.pin || "").trim();
    const found = (board.state.team || []).find(
      (u) => (u.user || "").toLowerCase() === who || (u.name || "").trim().toLowerCase() === who
    );
    /* hash either way, so a wrong username and a wrong PIN cost the same time */
    const given = await pinHash(pin);
    if (!found || !sameString(given, found.pin)) {
      return json({ ok: false, error: "That username and PIN don't match." }, 401);
    }
    return json(
      { ok: true, me: { id: found.id, name: found.name, user: found.user, role: found.role } },
      200,
      { "set-cookie": await issueSession(env, found.id) }
    );
  }

  if (path === "/api/logout" && request.method === "POST") {
    return json({ ok: true }, 200, {
      "set-cookie": "ds=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
    });
  }

  if (!me) return json({ ok: false, error: "signed_out" }, 401);

  if (path === "/api/state" && request.method === "GET") {
    return json({
      ok: true, version: board.version, state: forViewer(board.state, me),
      me: { id: me.id, name: me.name, user: me.user, role: me.role }
    });
  }

  if (path === "/api/state" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (typeof body.version !== "number" || !body.state || typeof body.state !== "object") {
      return json({ ok: false, error: "bad_request" }, 400);
    }
    if (body.version !== board.version) {
      return json({
        ok: false, error: "conflict", version: board.version,
        state: forViewer(board.state, me)
      }, 409);
    }
    const merged = mergeSave(board.state, body.state, me);
    const version = await saveBoard(env, board.version, merged);
    if (version == null) {
      const now = await loadBoard(env);
      return json({
        ok: false, error: "conflict", version: now.version, state: forViewer(now.state, me)
      }, 409);
    }
    return json({ ok: true, version, state: forViewer(merged, me) });
  }

  if (path === "/api/pin" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const oldPin = String(body.oldPin || "").trim();
    const newPin = String(body.newPin || "").trim();
    if (!/^\d{4,8}$/.test(newPin)) {
      return json({ ok: false, error: "New PIN must be 4–8 digits." }, 400);
    }
    if (!sameString(await pinHash(oldPin), me.pin)) {
      return json({ ok: false, error: "Your current PIN is not right." }, 403);
    }
    const next = JSON.parse(JSON.stringify(board.state));
    const t = next.team.find((u) => u.id === me.id);
    t.pin = await pinHash(newPin);
    next.defaultPins = next.team.some((u) => u.pin === SEED.defaultPinHash);
    next.updatedAt = new Date().toISOString();
    const version = await saveBoard(env, board.version, next);
    if (version == null) return json({ ok: false, error: "conflict" }, 409);
    return json({ ok: true, version });
  }

  return json({ ok: false, error: "not_found" }, 404);
}

/* ============ the Worker ============ */

function harden(res) {
  const h = new Headers(res.headers);
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "same-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  h.set(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return harden(await api(request, env, url.pathname));
      } catch (err) {
        return harden(json({ ok: false, error: "server_error", detail: String(err && err.message) }, 500));
      }
    }
    if (url.pathname === "/robots.txt") {
      return harden(new Response("User-agent: *\nDisallow: /\n", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      }));
    }
    /* everything else is the app itself */
    const asset = await env.ASSETS.fetch(new Request(new URL("/", url), request));
    return harden(asset);
  }
};
