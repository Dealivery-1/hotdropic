// How scanner products are priced. All amounts in cents.
// Retail = (supplier cost + supplier shipping) x a multiplier that shrinks as the price grows,
// at least $8 above cost, rounded up to end in .99. Card fees (2.9% + 30c) come out of that margin.

export function retailCents(costCents, shipCents, markup = 1) {
  const base = Math.max(0, Math.round(costCents)) + Math.max(0, Math.round(shipCents));
  const mult = base < 1000 ? 2.3 : base < 2500 ? 1.95 : base < 5000 ? 1.7 : 1.5;
  let price = Math.max(base * mult * markup, base + 800);
  price = Math.ceil(price / 100) * 100 - 1;
  return Math.max(price, 999);
}

/** Stripe's standard US card fee, for profit estimates. */
export const stripeFee = (amountCents) => Math.round(amountCents * 0.029 + 30);

/** "$1.23 -- 4.56", "1.23", 1.23 -> cents of the lowest number, or NaN. */
export function parsePriceCents(v) {
  if (typeof v === 'number') return Math.round(v * 100);
  const nums = String(v ?? '').match(/\d+(?:\.\d+)?/g);
  if (!nums) return NaN;
  return Math.round(Math.min(...nums.map(Number)) * 100);
}
