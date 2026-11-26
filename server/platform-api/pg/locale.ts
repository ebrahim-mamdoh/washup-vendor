import "server-only";

import { dialOf, isValidPhone, toE164 } from "../shared/phone";
import type { Q } from "./sql";

/**
 * Country rules for a branch or business (GAP-013), read from `public.countries` through the
 * branch's area. Egypt is the fallback for rows without an area/country (legacy data).
 */
export type Locale = {
  country: string;
  dialCode: string;
  currency: string;
  symbol: string;
  decimals: number;
  timezone: string;
  lat: number | null;
  lng: number | null;
};

export const EGYPT: Locale = {
  country: "EG",
  dialCode: "+20",
  currency: "EGP",
  symbol: "ج.م",
  decimals: 2,
  timezone: "Africa/Cairo",
  lat: 30.0444,
  lng: 31.2357,
};

const COLS = (q: Q) => q`
  c.code as country, c.dial_code as "dialCode", c.currency, c.currency_symbol ->> 'ar' as symbol,
  c.currency_decimals::int as decimals, c.timezone, c.lat::float8 as lat, c.lng::float8 as lng`;

export async function branchLocale(q: Q, branchId: string): Promise<Locale> {
  const [row] = await q<Locale[]>`
    select ${COLS(q)} from public.branches b
    join public.areas a on a.id = b.area_id
    join public.countries c on c.code = a.country_code
    where b.id = ${branchId}`;
  return row ?? EGYPT;
}

/** The business's country: that of its branches (the owner's home branch first). */
export async function businessLocale(q: Q, businessId: string): Promise<Locale> {
  const [row] = await q<Locale[]>`
    select ${COLS(q)} from public.branches b
    join public.areas a on a.id = b.area_id
    join public.countries c on c.code = a.country_code
    left join public.businesses bz on bz.id = b.business_id
    left join public.staff ow on ow.id = bz.owner_staff_id
    where b.business_id = ${businessId}
    order by (b.id = ow.branch_id) desc nulls last, b.id
    limit 1`;
  return row ?? EGYPT;
}

/**
 * Staff sign-in / password reset: which stored phone does this input mean?
 * - international input (+…, 00…) is taken as typed;
 * - a national number is tried as Egyptian first (every existing account), then as the single
 *   staff phone in another supported country with exactly that national number — so an owner in
 *   Riyadh can type 0501234567 without a country picker. The password still decides access.
 */
export async function staffPhoneFor(q: Q, input: string): Promise<string | null> {
  const raw = String(input ?? "").trim();
  const asEgypt = toE164(raw);
  if (/^(\+|00)/.test(raw)) return isValidPhone(asEgypt) ? asEgypt : null;
  if (isValidPhone(asEgypt)) {
    const [hit] = await q`select 1 from public.staff where phone = ${asEgypt} limit 1`;
    if (hit) return asEgypt;
  }
  const nsn = raw.replace(/\D/g, "").replace(/^0+/, "");
  if (nsn.length >= 7) {
    const rows = await q<{ phone: string }[]>`
      select distinct phone from public.staff where phone like ${"%" + nsn} and phone not like '+20%' limit 2`;
    const exact = rows.filter((r) => isValidPhone(r.phone) && r.phone === `+${dialOf(r.phone)}${nsn}`);
    if (exact.length === 1) return exact[0].phone;
  }
  return isValidPhone(asEgypt) ? asEgypt : null;
}
