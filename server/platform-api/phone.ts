/**
 * Phone numbers across countries (GAP-013). Pure helpers shared by the mock and Postgres servers.
 *
 * Storage is E.164 (`+201001234567`, `+966501234567`). Input may be:
 * - international: `+966 50 123 4567`, `00966501234567`, or digits that already start with a known
 *   dial code and are long enough to include it (`966501234567`);
 * - national: `0501234567` / `501234567` — completed with the caller's default dial code (the
 *   branch's or business's country; Egypt when unknown, which keeps every existing `01…` login working).
 *
 * Dial codes are those of `public.countries` (Arab League, migration 20261103120000_multi_country).
 */
export const DIAL_CODES = [
  "20", "212", "213", "216", "218", "222", "249", "252", "253", "269",
  "961", "962", "963", "964", "965", "966", "967", "968", "970", "971", "973", "974",
] as const;

const BY_LENGTH = [...DIAL_CODES].sort((a, b) => b.length - a.length);
const EG = "20";

/** National significant number length per dial code (without the trunk 0). Unlisted: 7–10. */
const NSN_LENGTH: Record<string, [number, number]> = {
  "20": [8, 10],
  "966": [8, 9],
  "971": [8, 9],
  "965": [7, 8],
  "974": [7, 8],
  "973": [8, 8],
  "968": [8, 8],
  "962": [8, 9],
  "961": [7, 8],
  "964": [8, 10],
  "963": [8, 9],
  "970": [8, 9],
  "967": [7, 9],
  "218": [8, 9],
  "216": [8, 8],
  "213": [8, 9],
  "212": [9, 9],
  "249": [9, 9],
};

const digitsOf = (s: string) => String(s ?? "").replace(/\D/g, "");

/** The dial code (digits, no "+") an E.164 number starts with, or null. */
export function dialOf(e164: string): string | null {
  const d = digitsOf(e164);
  return BY_LENGTH.find((c) => d.startsWith(c)) ?? null;
}

/**
 * Any phone input → E.164, or "" when there are no digits.
 * `defaultDial` ("+966" or "966") completes national numbers; defaults to Egypt.
 */
export function toE164(input: string, defaultDial: string = EG): string {
  const raw = String(input ?? "").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) {
    const d = digitsOf(raw);
    return d ? `+${d}` : "";
  }
  let d = digitsOf(raw);
  if (!d) return "";
  if (d.startsWith("00")) return `+${d.slice(2)}`;
  const dial = digitsOf(defaultDial) || EG;
  // Already carries a dial code (e.g. "201001234567", "966501234567").
  const known = dialOf(d);
  if (known && !d.startsWith("0")) {
    const [, max] = NSN_LENGTH[known] ?? [7, 10];
    if (d.length > max) return `+${d}`;
  }
  d = d.replace(/^0+/, "");
  return `+${dial}${d}`;
}

/** True for a plausible E.164 number of a supported country (length checked per country). */
export function isValidPhone(e164: string): boolean {
  if (!/^\+\d{8,15}$/.test(e164)) return false;
  const dial = dialOf(e164);
  if (!dial) return false;
  const nsn = e164.slice(1 + dial.length);
  const [min, max] = NSN_LENGTH[dial] ?? [7, 10];
  if (nsn.length < min || nsn.length > max) return false;
  // Egyptian mobiles: 10 digits starting with 1 (landlines 8–9 digits are still allowed above).
  return !(dial === EG && nsn.length === 10 && !nsn.startsWith("1"));
}

/** Input → E.164 when valid, else null. */
export function parsePhone(input: string, defaultDial: string = EG): string | null {
  const e = toE164(input, defaultDial);
  return e && isValidPhone(e) ? e : null;
}

/**
 * Display format. Egypt keeps the historic groups (`+20 1XX XXX XXXX`, `+20 2 XXXX XXXX`,
 * `+20 XX XXX XXXX`) — also for bare national numbers, as before. Other countries:
 * `+966 50 123 4567`.
 */
export function prettyPhone(p: string): string {
  const raw = String(p ?? "").trim();
  if (!raw) return "";
  const d = digitsOf(raw);
  if (!d) return "";
  const dial = raw.startsWith("+") || raw.startsWith("00") ? dialOf(d.replace(/^00/, "")) : null;
  if (dial && dial !== EG) {
    const n = d.replace(/^00/, "").slice(dial.length);
    if (n.length <= 4) return `+${dial} ${n}`;
    return `+${dial} ${n.slice(0, 2)} ${n.slice(2, n.length - 4)} ${n.slice(-4)}`.replace(/\s+/g, " ");
  }
  let n = d;
  if (n.startsWith("0020")) n = n.slice(4);
  else if (n.startsWith("20") && n.length > 10) n = n.slice(2);
  n = n.replace(/^0+/, "");
  if (n.length === 10 && n.startsWith("1")) return `+20 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  if (n.length === 9 && (n.startsWith("2") || n.startsWith("3"))) return `+20 ${n[0]} ${n.slice(1, 5)} ${n.slice(5)}`;
  if (n.length >= 8) return `+20 ${n.slice(0, 2)} ${n.slice(2, 5)} ${n.slice(5)}`;
  return n ? `+20 ${n}` : "";
}
