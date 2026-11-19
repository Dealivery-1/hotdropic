// GET  /api/order?session_id=cs_...      the order page right after checkout
// POST /api/order {id, email}             "Track my order" (order number + the email used at checkout)
import { getOrder, getOrderBySession } from '../../server/lib/db.js';
import { publicOrder } from '../../server/lib/fulfill.js';
import { handle, HttpError, json, readJson } from '../../server/lib/http.js';

export const onRequestGet = handle(async ({ request, env }) => {
  const sid = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sid)) throw new HttpError(400, 'Missing or invalid order link.');
  const order = await getOrderBySession(env, sid);
  if (!order) throw new HttpError(404, "We couldn't find that order yet. If you just paid, refresh in a few seconds.");
  return json({ order: publicOrder(order) });
});

export const onRequestPost = handle(async ({ request, env }) => {
  const body = await readJson(request);
  const id = String(body.id || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const email = String(body.email || '').trim().toLowerCase();
  const notFound = new HttpError(404, 'No order matches that order number and email. Check the receipt Stripe emailed you.');
  if (!/^HD[A-Z0-9]{8}$/.test(id) || !email.includes('@')) throw notFound;
  const order = await getOrder(env, id);
  if (!order || String(order.email || '').toLowerCase() !== email || ['pending', 'expired'].includes(order.status)) throw notFound;
  return json({ order: publicOrder(order) });
});
