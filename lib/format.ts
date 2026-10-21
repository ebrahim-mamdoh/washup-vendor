import type { Localized } from "@/types/common";

/**
 * Formatting rules from the Carzen spec: Western digits in both languages,
 * money as `180 ج.م`, 12-hour times, Arabic month names.
 */

const AR_MONTHS = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export function formatNumber(value: number | null | undefined, decimals = false): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return (decimals ? decFmt : intFmt).format(value);
}

export function formatCompact(value: number): string {
  return compactFmt.format(value);
}

export function formatMoney(value: number | null | undefined, { decimals = false } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(decimals ? decFmt : intFmt).format(value)} ج.م`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits).replace(/\.0+$/, "")}٪`;
}

export function formatTime(input: string | Date): string {
  const d = new Date(input);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h % 12 || 12}:${m} ${h >= 12 ? "م" : "ص"}`;
}

export function formatDate(input: string | Date, { withDay = false, withYear = false } = {}): string {
  const d = new Date(input);
  const parts = [`${d.getDate()} ${AR_MONTHS[d.getMonth()]}`];
  if (withYear) parts.push(String(d.getFullYear()));
  const base = parts.join(" ");
  return withDay ? `${AR_DAYS[d.getDay()]} ${base}` : base;
}

export function formatDateTime(input: string | Date): string {
  return `${formatDate(input)} · ${formatTime(input)}`;
}

/** "منذ 3 أيام" / "بعد ساعتين" style relative labels. */
export function formatRelative(input: string | Date, from: Date = serverNow()): string {
  const diffMs = new Date(input).getTime() - from.getTime();
  const past = diffMs < 0;
  const mins = Math.round(Math.abs(diffMs) / 60000);
  const wrap = (s: string) => (past ? `منذ ${s}` : `بعد ${s}`);

  if (mins < 1) return "الآن";
  if (mins < 60) return wrap(mins === 1 ? "دقيقة" : mins === 2 ? "دقيقتين" : `${mins} دقيقة`);
  const hours = Math.round(mins / 60);
  if (hours < 24) return wrap(hours === 1 ? "ساعة" : hours === 2 ? "ساعتين" : `${hours} ساعات`);
  const days = Math.round(hours / 24);
  if (days === 1) return past ? "أمس" : "غدًا";
  if (days < 30) return wrap(days === 2 ? "يومين" : `${days} ${days <= 10 ? "أيام" : "يوم"}`);
  const months = Math.round(days / 30);
  return wrap(months === 1 ? "شهر" : months === 2 ? "شهرين" : `${months} شهور`);
}

export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} د`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} س ${m} د` : `${h} س`;
}

export function initials(name: string | null | undefined): string {
  const parts = String(name ?? "").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] ?? "").join("").toUpperCase() || "؟";
}

/** Admin UI is Arabic-first; English is shown as secondary text where useful. */
export function ar(text: Localized | null | undefined): string {
  return text?.ar ?? "—";
}

/** Days between two ISO dates, for "waiting N days" style badges. */
export function daysBetween(from: string | Date, to: Date = serverNow()): number {
  const a = new Date(from);
  a.setHours(0, 0, 0, 0);
  const b = new Date(to);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// ── Audit values ─────────────────────────────────────────────
// Audit entries store before/after values as text; structured ones are JSON
// (shift patterns, permissions, settings…). Show them as readable Arabic.

const AUDIT_KEY_LABELS: Record<string, string> = {
  name: "الاسم",
  title: "العنوان",
  price: "السعر",
  durationMin: "المدة",
  active: "مفعّل",
  role: "الدور",
  branchId: "الفرع",
  maxDiscountPct: "حد الخصم",
  permissions: "الصلاحيات",
  capacity: "السعة",
  discount: "الخصم",
  email: "البريد",
  ownerName: "المالك",
  commissionRate: "العمولة",
  autoConfirm: "تأكيد تلقائي",
  slotIntervalMin: "مدة الموعد",
  leadTimeMin: "مهلة الحجز",
  maxAdvanceDays: "أقصى أيام مسبقة",
  freeCancelMin: "الإلغاء المجاني",
  noShowGraceMin: "مهلة عدم الحضور",
  reminderMin: "التذكير",
};

const clock = (hhmm: unknown) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return Number.isNaN(h) ? String(hhmm) : `${h % 12 || 12}:${String(m || 0).padStart(2, "0")} ${h >= 12 && h < 24 ? "م" : "ص"}`;
};

function auditPart(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (Array.isArray(value)) return value.map(auditPart).join("، ");
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Weekly shift pattern.
    if ("start" in o && "end" in o && Array.isArray(o.days)) return `${clock(o.start)}–${clock(o.end)} (${o.days.length} أيام)`;
    // Localized text.
    if (typeof o.ar === "string") return o.ar;
    const entries = Object.entries(o);
    // Permission maps: count what is granted.
    if (entries.length && entries.every(([, v]) => typeof v === "boolean")) {
      return `${entries.filter(([, v]) => v).length}/${entries.length} مفعّلة`;
    }
    return entries.map(([k, v]) => `${AUDIT_KEY_LABELS[k] ?? k}: ${auditPart(v)}`).join("، ");
  }
  return String(value);
}

/** Status codes stored in audit values (orders, payments, offers, reviews, shifts, accounts). */
const AUDIT_WORDS: Record<string, string> = {
  pending: "بانتظار",
  confirmed: "مؤكد",
  waiting: "في الانتظار",
  in_service: "جارٍ التنفيذ",
  completed: "مكتمل",
  cancelled: "ملغي",
  no_show: "لم يحضر",
  paid: "مدفوع",
  refunded: "مسترد",
  settled: "مُسوّى",
  draft: "مسودة",
  scheduled: "مجدول",
  active: "نشط",
  expired: "منتهي",
  disabled: "موقوف",
  suspended: "موقوف",
  approved: "معتمد",
  rejected: "مرفوض",
  visible: "ظاهر",
  hidden: "مخفي",
  reported: "مُبلغ عنه",
  open: "مفتوحة",
  submitted: "مُسلّمة",
  reviewed: "تمت المراجعة",
  flagged: "للمتابعة",
  inactive: "غير نشط",
};

/** An audit old/new value for display: JSON becomes readable text, status codes become Arabic. */
export function formatAuditValue(v: string | null): string | null {
  if (!v) return null;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) {
    return t.split(" · ").map((part) => AUDIT_WORDS[part] ?? part).join(" · ");
  }
  try {
    return auditPart(JSON.parse(t));
  } catch {
    return v;
  }
}

// ── Server clock calibration ─────────────────────────────────
// The platform API runs a demo clock (and production servers can differ from
// the device clock). The axios client feeds the X-Demo-Now header here so every
// relative label and timer is computed against the server's time.

let serverOffsetMs = 0;

export function setServerNow(iso: string | null | undefined): void {
  const t = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isNaN(t)) serverOffsetMs = t - Date.now();
}

export function serverNow(): Date {
  return new Date(Date.now() + serverOffsetMs);
}

/** Whole minutes elapsed since the given time on the server clock (never negative). */
export function minutesSince(iso: string | Date): number {
  return Math.max(0, Math.round((serverNow().getTime() - new Date(iso).getTime()) / 60000));
}
