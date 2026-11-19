// Cloudflare D1 (binding DB in wrangler.jsonc). Tables are created on first use, so there is nothing to migrate.
// kv     = small JSON blobs: settings, the trending catalog, scanner/promo state, cached tokens
// orders = one row per checkout
import { HttpError } from './http.js';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    session_id TEXT,
    email TEXT,
    name TEXT,
    phone TEXT,
    shipping TEXT,
    items TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    shipping_fee INTEGER NOT NULL,
    discount INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    est_cost INTEGER NOT NULL DEFAULT 0,
    supplier TEXT,
    log TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_check INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS orders_status ON orders(status, next_check)`,
  `CREATE INDEX IF NOT EXISTS orders_session ON orders(session_id)`,
  `CREATE INDEX IF NOT EXISTS orders_created ON orders(created_at)`,
  `CREATE TABLE IF NOT EXISTS logins (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, first INTEGER NOT NULL)`,
];

const ready = new WeakMap();

export async function db(env) {
  if (!env.DB) throw new HttpError(503, 'The database is not connected yet (DB binding missing). See SETUP.md.');
  if (!ready.has(env.DB)) {
    const p = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => {
      ready.delete(env.DB);
      throw e;
    });
    ready.set(env.DB, p);
  }
  await ready.get(env.DB);
  return env.DB;
}

const parse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export async function kvGet(env, key, fallback = null) {
  const row = await (await db(env)).prepare('SELECT v FROM kv WHERE k = ?').bind(key).first();
  return row ? parse(row.v, fallback) : fallback;
}

/** Several keys in one query. Returns { key: value } (missing keys are absent). */
export async function kvGetMany(env, keys) {
  if (!keys.length) return {};
  const d = await db(env);
  const { results } = await d.prepare(`SELECT k, v FROM kv WHERE k IN (${keys.map(() => '?').join(',')})`).bind(...keys).all();
  const out = {};
  for (const r of results || []) out[r.k] = parse(r.v, null);
  return out;
}

export async function kvSet(env, key, value) {
  await (await db(env))
    .prepare('INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at')
    .bind(key, JSON.stringify(value), Date.now())
    .run();
}

export async function kvDelete(env, key) {
  await (await db(env)).prepare('DELETE FROM kv WHERE k = ?').bind(key).run();
}

// ---------------------------------------------------------------- orders
const JSON_COLS = ['shipping', 'items', 'supplier', 'log'];

function rowToOrder(r) {
  if (!r) return null;
  const o = { ...r };
  for (const c of JSON_COLS) o[c] = parse(r[c] || (c === 'items' || c === 'log' ? '[]' : 'null'), c === 'items' || c === 'log' ? [] : null);
  return o;
}

export async function insertOrder(env, o) {
  const now = Date.now();
  await (await db(env))
    .prepare(
      `INSERT INTO orders (id, created_at, updated_at, status, session_id, email, name, phone, shipping, items, subtotal, shipping_fee, discount, tax, total, est_cost, supplier, log, attempts, next_check)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
    )
    .bind(o.id, now, now, o.status, o.session_id || null, o.email || null, o.name || null, o.phone || null, JSON.stringify(o.shipping || null),
      JSON.stringify(o.items), o.subtotal, o.shipping_fee, o.discount || 0, o.tax || 0, o.total, o.est_cost || 0, JSON.stringify(o.supplier || null),
      JSON.stringify(o.log || []))
    .run();
  return { ...o, created_at: now, updated_at: now, attempts: 0, next_check: 0 };
}

export async function getOrder(env, id) {
  return rowToOrder(await (await db(env)).prepare('SELECT * FROM orders WHERE id = ?').bind(id).first());
}

export async function getOrderBySession(env, sessionId) {
  return rowToOrder(await (await db(env)).prepare('SELECT * FROM orders WHERE session_id = ?').bind(sessionId).first());
}

const UPDATABLE = new Set(['status', 'session_id', 'email', 'name', 'phone', 'shipping', 'items', 'subtotal', 'shipping_fee', 'discount', 'tax', 'total', 'est_cost', 'supplier', 'log', 'attempts', 'next_check']);

export async function updateOrder(env, id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (!keys.length) return;
  const vals = keys.map((k) => (JSON_COLS.includes(k) ? JSON.stringify(patch[k] ?? null) : patch[k] ?? null));
  await (await db(env))
    .prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .bind(...vals, Date.now(), id)
    .run();
}

function setClause(patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  const vals = keys.map((k) => (JSON_COLS.includes(k) ? JSON.stringify(patch[k] ?? null) : patch[k] ?? null));
  return { sql: keys.map((k) => `${k} = ?`).join(', '), vals };
}

/**
 * Atomic status change: applies `patch` only if the order is still in one of the `from` statuses
 * (or is a 'fulfilling' order whose lease ran out before `staleBefore`). Returns true if this call won.
 * This is what stops two workers (webhook retry, cron, admin button) from ordering from a supplier twice.
 */
export async function transitionOrder(env, id, from, patch, { staleBefore = null } = {}) {
  const { sql, vals } = setClause(patch);
  let where = `status IN (${from.map(() => '?').join(',')})`;
  const params = [...from];
  if (staleBefore) {
    where = `(${where} OR (status = 'fulfilling' AND next_check <= ?))`;
    params.push(staleBefore);
  }
  const r = await (await db(env))
    .prepare(`UPDATE orders SET ${sql}, updated_at = ? WHERE id = ? AND ${where}`)
    .bind(...vals, Date.now(), id, ...params)
    .run();
  return Number(r?.meta?.changes ?? 0) === 1;
}

/** Update only if the status is still `expected` (so a slow job can't undo a refund or a newer change). */
export async function updateOrderIf(env, id, expected, patch) {
  return transitionOrder(env, id, [expected], patch);
}

/** Counts a login attempt atomically (one row per IP or IPv6 /64). Returns attempts in the current 15-minute window. */
export async function countLogin(env, key, now = Date.now()) {
  const row = await (await db(env))
    .prepare(
      `INSERT INTO logins (ip, n, first) VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET n = CASE WHEN ? - first > 900000 THEN 1 ELSE n + 1 END,
                                     first = CASE WHEN ? - first > 900000 THEN ? ELSE first END
       RETURNING n`,
    )
    .bind(key, now, now, now, now)
    .first();
  return Number(row?.n || 1);
}

export async function clearLogins(env, key) {
  await (await db(env)).prepare('DELETE FROM logins WHERE ip = ?').bind(key).run();
}

/** Appends a line to an order's history (kept to the last 40). */
export function withLog(order, ...lines) {
  const t = Date.now();
  return [...(order.log || []), ...lines.filter(Boolean).map((msg) => ({ t, msg: String(msg).slice(0, 400) }))].slice(-40);
}

export async function listOrders(env, { limit = 50, status = null } = {}) {
  const d = await db(env);
  const q = status
    ? d.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?').bind(status, limit)
    : d.prepare("SELECT * FROM orders WHERE status != 'pending' AND status != 'expired' ORDER BY created_at DESC LIMIT ?").bind(limit);
  const { results } = await q.all();
  return (results || []).map(rowToOrder);
}

/** Orders in one of `statuses` whose next_check time has passed (for the cron). */
export async function dueOrders(env, statuses, limit = 5, now = Date.now()) {
  const d = await db(env);
  const { results } = await d
    .prepare(`SELECT * FROM orders WHERE status IN (${statuses.map(() => '?').join(',')}) AND next_check <= ? ORDER BY next_check ASC LIMIT ?`)
    .bind(...statuses, now, limit)
    .all();
  return (results || []).map(rowToOrder);
}

export async function salesStats(env, now = Date.now()) {
  const d = await db(env);
  const since = (days) => now - days * 86400000;
  const paid = "status NOT IN ('pending', 'expired', 'canceled', 'refunded')";
  const row = await d
    .prepare(
      `SELECT
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d1_orders, SUM(CASE WHEN created_at >= ? THEN total ELSE 0 END) AS d1_revenue,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d7_orders, SUM(CASE WHEN created_at >= ? THEN total ELSE 0 END) AS d7_revenue,
        SUM(CASE WHEN created_at >= ? THEN total - est_cost - tax ELSE 0 END) AS d7_profit,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS d30_orders, SUM(CASE WHEN created_at >= ? THEN total ELSE 0 END) AS d30_revenue,
        SUM(CASE WHEN created_at >= ? THEN total - est_cost - tax ELSE 0 END) AS d30_profit,
        COUNT(*) AS all_orders, SUM(total) AS all_revenue, SUM(total - est_cost - tax) AS all_profit
       FROM orders WHERE ${paid}`,
    )
    .bind(since(1), since(1), since(7), since(7), since(7), since(30), since(30), since(30))
    .first();
  const out = {};
  for (const [k, v] of Object.entries(row || {})) out[k] = Number(v) || 0;
  return out;
}
