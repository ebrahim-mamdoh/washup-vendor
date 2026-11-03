import "server-only";

import type { Localized } from "@/types/common";

import { MockApiError, ok, requireText } from "../../http";
import { branchById } from "../entities";
import { logAudit } from "../platform";
import { route } from "../router";
import { db, tx } from "../sql";

/** The pin every new wash got while the map had no API key. Reject it so branches are not stacked on one point. */
export const LEGACY_DEFAULT_PIN = { lat: 30.0131, lng: 31.4395 };

export function isLegacyDefaultPin(lat: number, lng: number): boolean {
  return Math.abs(lat - LEGACY_DEFAULT_PIN.lat) < 0.00005 && Math.abs(lng - LEGACY_DEFAULT_PIN.lng) < 0.00005;
}

export function requirePin(lat: unknown, lng: unknown): { lat: number; lng: number } {
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180 || (la === 0 && ln === 0)) {
    throw new MockApiError("حدد موقع الدبوس على الخريطة", 422, { lat: ["الموقع مطلوب"] });
  }
  if (isLegacyDefaultPin(la, ln)) {
    throw new MockApiError("حرّك الدبوس إلى موقع الفرع الفعلي — الإحداثيات الافتراضية غير مقبولة", 422, { lat: ["موقع افتراضي"] });
  }
  return { lat: Math.round(la * 1e6) / 1e6, lng: Math.round(ln * 1e6) / 1e6 };
}

export type CountryRow = {
  code: string;
  name: Localized;
  currency: string;
  currencySymbol: Localized;
  currencyDecimals: number;
  timezone: string;
  dialCode: string;
  lat: number;
  lng: number;
  active: boolean;
  sortOrder: number;
};

export type AreaRow = {
  id: string;
  name: Localized;
  countryCode: string;
  countryName: Localized;
  lat: number | null;
  lng: number | null;
  active: boolean;
  sortOrder: number;
};

const COUNTRY_COLS = `c.code, c.name, c.currency, c.currency_symbol as "currencySymbol", c.currency_decimals as "currencyDecimals",
  c.timezone, c.dial_code as "dialCode", c.lat, c.lng, c.active, c.sort_order as "sortOrder"`;

const AREA_COLS = `a.id, a.name, a.country_code as "countryCode", c.name as "countryName", a.lat, a.lng, a.active, a.sort_order as "sortOrder"`;

function clampSort(value: unknown): number {
  const n = Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
  return Math.max(-32768, Math.min(32767, n));
}

function slugId(en: string): string {
  const slug = en
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug || `area_${Date.now().toString(36)}`;
}

export const geoRoutes = [
  route("GET", "/admin/countries", async () => {
    const rows = await db()<CountryRow[]>`
      select ${db().unsafe(COUNTRY_COLS)} from public.countries c order by c.sort_order, c.code`;
    return ok(rows);
  }),

  route("PATCH", "/admin/countries/:code", async ({ params, body, admin }) => {
    const code = params.code.trim().toUpperCase();
    const active = Boolean(body.active);
    const reason = requireText(body.reason, "reason", "السبب");
    const country = await tx(async (t) => {
      const [current] = await t<CountryRow[]>`select ${t.unsafe(COUNTRY_COLS)} from public.countries c where c.code = ${code}`;
      if (!current) throw new MockApiError("الدولة غير موجودة", 404);
      await t`update public.countries set active = ${active}, updated_at = now() where code = ${code}`;
      await logAudit(t, {
        actorId: admin.id,
        action: active ? "activate_country" : "deactivate_country",
        entity: "countries",
        entityId: code,
        oldValue: current.active ? "active" : "inactive",
        newValue: active ? "active" : "inactive",
        reason,
      });
      return { ...current, active };
    });
    return ok(country, country.active ? "تم تفعيل الدولة" : "تم إيقاف الدولة");
  }),

  route("GET", "/admin/areas", async ({ query }) => {
    const sql = db();
    const country = query.get("country")?.trim().toUpperCase() || null;
    const rows = await sql<AreaRow[]>`
      select ${sql.unsafe(AREA_COLS)}
      from public.areas a join public.countries c on c.code = a.country_code
      where ${country && country !== "ALL" ? sql`a.country_code = ${country}` : sql`true`}
      order by c.sort_order, a.sort_order, a.id`;
    return ok(rows);
  }),

  route("POST", "/admin/areas", async ({ body, admin }) => {
    const nameAr = requireText(body.nameAr, "nameAr", "الاسم بالعربية", 2);
    const nameEn = requireText(body.nameEn, "nameEn", "الاسم بالإنجليزية", 2);
    const countryCode = requireText(body.countryCode, "countryCode", "الدولة", 2).toUpperCase();
    const pin = requirePin(body.lat, body.lng);
    const active = body.active !== false;
    const sortOrder = clampSort(body.sortOrder);
    const area = await tx(async (t) => {
      const [country] = await t<{ code: string }[]>`select code from public.countries where code = ${countryCode}`;
      if (!country) throw new MockApiError("الدولة غير موجودة", 422, { countryCode: ["دولة غير معروفة"] });
      let id = slugId(nameEn);
      const [taken] = await t<{ id: string }[]>`select id from public.areas where id = ${id}`;
      if (taken) id = `${id}-${Date.now().toString(36).slice(-4)}`;
      const name = { ar: nameAr, en: nameEn };
      await t`
        insert into public.areas (id, name, country_code, lat, lng, active, sort_order)
        values (${id}, ${t.json(name)}, ${countryCode}, ${pin.lat}, ${pin.lng}, ${active}, ${sortOrder})`;
      await logAudit(t, {
        actorId: admin.id,
        action: "create_area",
        entity: "areas",
        entityId: id,
        oldValue: null,
        newValue: `${nameAr} · ${countryCode} · ${pin.lat},${pin.lng}`,
        reason: "إضافة منطقة",
      });
      const [row] = await t<AreaRow[]>`
        select ${t.unsafe(AREA_COLS)} from public.areas a join public.countries c on c.code = a.country_code where a.id = ${id}`;
      return row;
    });
    return ok(area, "تمت إضافة المنطقة");
  }),

  route("PATCH", "/admin/areas/:id", async ({ params, body, admin }) => {
    const pin = requirePin(body.lat, body.lng);
    const nameAr = requireText(body.nameAr, "nameAr", "الاسم بالعربية", 2);
    const nameEn = requireText(body.nameEn, "nameEn", "الاسم بالإنجليزية", 2);
    const countryCode = requireText(body.countryCode, "countryCode", "الدولة", 2).toUpperCase();
    const active = body.active !== false;
    const sortOrder = clampSort(body.sortOrder);
    const area = await tx(async (t) => {
      const [current] = await t<{ id: string }[]>`select id from public.areas where id = ${params.id}`;
      if (!current) throw new MockApiError("المنطقة غير موجودة", 404);
      const [country] = await t<{ code: string }[]>`select code from public.countries where code = ${countryCode}`;
      if (!country) throw new MockApiError("الدولة غير موجودة", 422);
      const name = { ar: nameAr, en: nameEn };
      await t`
        update public.areas
        set name = ${t.json(name)}, country_code = ${countryCode}, lat = ${pin.lat}, lng = ${pin.lng},
            active = ${active}, sort_order = ${sortOrder}, updated_at = now()
        where id = ${params.id}`;
      await logAudit(t, {
        actorId: admin.id,
        action: "update_area",
        entity: "areas",
        entityId: params.id,
        oldValue: null,
        newValue: `${nameAr} · ${pin.lat},${pin.lng}`,
        reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "تعديل منطقة",
      });
      const [row] = await t<AreaRow[]>`
        select ${t.unsafe(AREA_COLS)} from public.areas a join public.countries c on c.code = a.country_code where a.id = ${params.id}`;
      return row;
    });
    return ok(area, "تم حفظ المنطقة");
  }),

  route("PATCH", "/admin/branches/:id/location", async ({ params, body, admin }) => {
    const pin = requirePin(body.lat, body.lng);
    const reason = requireText(body.reason, "reason", "السبب");
    const branch = await tx(async (t) => {
      const current = await branchById(t, params.id);
      await t`update public.branches set lat = ${pin.lat}, lng = ${pin.lng}, updated_at = now() where id = ${current.id}`;
      await logAudit(t, {
        actorId: admin.id,
        action: "update_branch_location",
        entity: "branches",
        entityId: current.id,
        branchId: current.id,
        oldValue: `${current.lat},${current.lng}`,
        newValue: `${pin.lat},${pin.lng}`,
        reason,
      });
      return { ...current, lat: pin.lat, lng: pin.lng };
    });
    return ok(branch, "تم تحديث موقع الفرع");
  }),
];
