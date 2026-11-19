// Alerts for you (new order, something needs attention) and optional emails to customers.
// Owner alerts go to any of: DISCORD_ORDERS_WEBHOOK_URL, TELEGRAM_BOT_TOKEN + TELEGRAM_OWNER_CHAT_ID,
// RESEND_API_KEY + OWNER_EMAIL + FROM_EMAIL. Stripe already emails customers their receipt.
import { money } from './http.js';

export function ownerChannels(env) {
  const out = [];
  if (env.DISCORD_ORDERS_WEBHOOK_URL) out.push('Discord');
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_CHAT_ID) out.push('Telegram');
  if (env.RESEND_API_KEY && env.OWNER_EMAIL && env.FROM_EMAIL) out.push('Email');
  return out;
}

export async function sendEmail(env, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !to) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL, to: [to], subject, text }),
  });
  return res.ok;
}

export async function notifyOwner(env, text, subject = 'The Hot Dropic') {
  const jobs = [];
  if (env.DISCORD_ORDERS_WEBHOOK_URL) {
    jobs.push(fetch(env.DISCORD_ORDERS_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: text.slice(0, 1900) }) }).then((r) => r.ok));
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_OWNER_CHAT_ID) {
    jobs.push(
      fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_OWNER_CHAT_ID, text: text.slice(0, 4000), disable_web_page_preview: true }),
      }).then((r) => r.ok),
    );
  }
  if (env.RESEND_API_KEY && env.OWNER_EMAIL && env.FROM_EMAIL) jobs.push(sendEmail(env, env.OWNER_EMAIL, subject, text));
  const results = await Promise.allSettled(jobs);
  return results.filter((r) => r.status === 'fulfilled' && r.value).length;
}

export function orderSummary(order) {
  const items = (order.items || []).map((i) => `${i.qty} x ${i.title}${i.variantLabel ? ` (${i.variantLabel})` : ''}`).join(', ');
  return `${order.id}: ${items} - ${money(order.total)}`;
}

export async function emailCustomerShipped(env, order, tracking, origin, siteName) {
  if (!order.email || !tracking.length) return false;
  const lines = tracking.map((t) => `${t.carrier || 'Tracking'}: ${t.number}${t.url ? `\n${t.url}` : ''}`).join('\n\n');
  const text = `Good news! Your ${siteName} order ${order.id} is on its way.\n\n${lines}\n\nTrack it any time: ${origin}/order.html?id=${encodeURIComponent(order.id)}\n\nThanks for shopping with us!`;
  return sendEmail(env, order.email, `Your ${siteName} order has shipped`, text);
}
