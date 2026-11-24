/**
 * Client-side check for a phone typed in the portal (GAP-013). Lenient on purpose: the server
 * reads national numbers in the branch's country and has the final say (`server/platform-api/phone.ts`).
 *
 * Accepts an Egyptian mobile (`01…`, `+20 1…`), any international number (`+966…`, `00966…`), or a
 * national number of another country (7–12 digits, e.g. `0501234567` for a branch in Riyadh).
 */
export function isPhoneInput(value: string): boolean {
  const raw = String(value ?? "").trim();
  const d = raw.replace(/\D/g, "");
  if (!d) return false;
  if (/^(\+|00)/.test(raw)) {
    const intl = d.replace(/^00/, "");
    if (intl.startsWith("20")) return /^20(1[0125]\d{8}|[2-9]\d{7,8})$/.test(intl);
    return intl.length >= 8 && intl.length <= 15;
  }
  if (d.startsWith("01")) return /^01[0125]\d{8}$/.test(d);
  if (d.startsWith("20") && d.length === 12) return /^201[0125]\d{8}$/.test(d);
  return d.length >= 7 && d.length <= 12;
}

export const PHONE_INPUT_ERROR = "رقم موبايل غير صحيح — للأرقام خارج مصر اكتب كود الدولة (مثال: +966 50 123 4567)";
