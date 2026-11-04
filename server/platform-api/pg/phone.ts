/**
 * E.164 phone normalization, validation, and display formatting.
 * Shared across SuperAdmin and Vendor portals.
 */

/** Normalizes any input phone number into E.164 international format (+<country><national>). */
export function toE164(input: string, defaultCountryCode = "20"): string {
  if (!input) return "";
  const trimmed = input.trim();
  
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }
  
  if (trimmed.startsWith("00")) {
    const digits = trimmed.slice(2).replace(/\D/g, "");
    return digits ? `+${digits}` : "";
  }
  
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  
  // Egyptian mobile 11 digits starting with 01 (e.g. 01012345678)
  // or Saudi mobile 10 digits starting with 05 (e.g. 0512345678)
  if (digits.startsWith("0")) {
    return `+${defaultCountryCode}${digits.slice(1)}`;
  }
  
  // Already has country code prefix without '+'
  if (digits.startsWith(defaultCountryCode) && digits.length > 10) {
    return `+${digits}`;
  }
  
  // International number starting with other country codes (e.g. 966, 971, 965...)
  if (digits.length >= 11 && (digits.startsWith("966") || digits.startsWith("971") || digits.startsWith("965") || digits.startsWith("974"))) {
    return `+${digits}`;
  }
  
  return `+${defaultCountryCode}${digits}`;
}

/** Legacy alias for backwards compatibility */
export const e164 = (p: string): string => toE164(p);

/** Validates that a phone string has a plausible E.164 digit length (8 to 15 digits). */
export function isValidPhone(input: string): boolean {
  if (!input) return false;
  const digits = input.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

/** Extracts national digits (without trunk 0 or country code 20). */
export function nationalPhone(p: string): string {
  let d = p.replace(/\D/g, "");
  if (d.startsWith("0020")) d = d.slice(4);
  else if (d.startsWith("20") && d.length > 10) d = d.slice(2);
  return d.replace(/^0+/, "");
}

/** Display format: Egyptian mobiles `+20 1XX XXX XXXX`, Saudi `+966 5X XXX XXXX`, etc. */
export function prettyPhone(p: string): string {
  if (!p) return "";
  const clean = toE164(p);
  if (!clean.startsWith("+")) return clean;
  
  const digits = clean.slice(1);
  if (digits.startsWith("20")) {
    const eg = digits.slice(2);
    if (eg.length === 10 && eg.startsWith("1")) {
      return `+20 ${eg.slice(0, 3)} ${eg.slice(3, 6)} ${eg.slice(6)}`;
    }
    if (eg.length === 9 && (eg.startsWith("2") || eg.startsWith("3"))) {
      return `+20 ${eg[0]} ${eg.slice(1, 5)} ${eg.slice(5)}`;
    }
    if (eg.length >= 8) {
      return `+20 ${eg.slice(0, 2)} ${eg.slice(2, 5)} ${eg.slice(5)}`;
    }
    return `+20 ${eg}`;
  }
  
  if (digits.startsWith("966")) {
    const sa = digits.slice(3);
    if (sa.length === 9) {
      return `+966 ${sa.slice(0, 2)} ${sa.slice(2, 5)} ${sa.slice(5)}`;
    }
    return `+966 ${sa}`;
  }
  
  return clean;
}

/** E.164 → the API display format */
export const apiPhone = (p: string | null): string => (p ? prettyPhone(p) : "");

/**
 * SQL expression for formatting any stored phone number.
 * Formats Egyptian numbers with standard spacing, while preserving valid international numbers.
 */
export const PHONE = (col: string) =>
  `(select case when d = '' then ''
                when d like '+20%' and length(d) = 13 and substr(d, 4, 1) = '1'
                  then '+20 ' || substr(d, 4, 3) || ' ' || substr(d, 7, 3) || ' ' || substr(d, 10)
                when d like '+20%' and length(d) = 12 and substr(d, 4, 1) in ('2', '3')
                  then '+20 ' || substr(d, 4, 1) || ' ' || substr(d, 5, 4) || ' ' || substr(d, 9)
                when d like '+966%' and length(d) = 13
                  then '+966 ' || substr(d, 5, 2) || ' ' || substr(d, 7, 3) || ' ' || substr(d, 10)
                when d like '+%' then d
                when length(d) = 10 and left(d, 1) = '1'
                  then '+20 ' || substr(d, 1, 3) || ' ' || substr(d, 4, 3) || ' ' || substr(d, 7)
                else '+20 ' || d end
    from (select regexp_replace(coalesce(${col}, ''), '[^0-9+]', '', 'g') as d) x)`;


/**
 * Rounds money to the specified number of decimal places (W8).
 * Defaults to 2 decimals.
 */
export function roundMoney(n: number, decimals = 2): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}
