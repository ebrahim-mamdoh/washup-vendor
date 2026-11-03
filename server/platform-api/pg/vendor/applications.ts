import "server-only";

import type { SubmitApplicationPayload } from "@/types/applications";
import { MockApiError, ok, requireText } from "../../http";
import { applicationsWhere } from "../entities";
import { isLegacyDefaultPin } from "../admin/geo";
import { pushAdminNotification } from "../platform";
import { vroute } from "../router";
import { type Q, db } from "../sql";

type CountryPick = {
  code: string;
  dialCode: string;
  currencyDecimals: number;
  active: boolean;
};

function clockMinutes(hhmm: string, isClose = false): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  const v = h * 60 + min;
  return isClose && v === 0 ? 1440 : v;
}

function assertWorkingHours(value: unknown) {
  if (!Array.isArray(value) || value.length !== 7) {
    throw new MockApiError("حدد ساعات العمل للأيام السبعة", 422, { workingHours: ["ساعات غير مكتملة"] });
  }
  let openDays = 0;
  for (const day of value) {
    const row = (day ?? {}) as { open?: string; close?: string; closed?: boolean };
    if (row.closed) continue;
    const open = clockMinutes(String(row.open ?? ""));
    const close = clockMinutes(String(row.close ?? ""), true);
    if (open === null || close === null || open >= close) {
      throw new MockApiError("وقت الفتح يجب أن يكون قبل وقت الإغلاق في كل يوم مفتوح", 422, { workingHours: ["وقت غير صالح"] });
    }
    openDays += 1;
  }
  if (!openDays) throw new MockApiError("يجب أن تعمل المغسلة يومًا واحدًا على الأقل", 422, { workingHours: ["كل الأيام عطلة"] });
}

async function toE164(sql: Q, raw: string, dial?: string): Promise<string> {
  const countries = await sql<{ dial_code: string }[]>`select dial_code from public.countries where active order by length(dial_code) desc`;
  const dials = countries.map((c) => c.dial_code.replace(/\D/g, "")).filter(Boolean);
  let digits = String(raw ?? "").replace(/\D/g, "");
  const preferred = String(dial ?? "").replace(/\D/g, "");
  if (preferred && !digits.startsWith(preferred)) digits = preferred + digits.replace(/^0+/, "");
  const matched = dials.find((d) => digits.startsWith(d));
  if (!matched) throw new MockApiError("اختر الدولة وأدخل رقم موبايل صحيح", 422, { phone: ["رقم غير صحيح"] });
  const national = digits.slice(matched.length).replace(/^0+/, "");
  if (national.length < 6 || national.length > 12) {
    throw new MockApiError("رقم الموبايل غير صحيح لهذه الدولة", 422, { phone: ["رقم غير صحيح"] });
  }
  return `+${matched}${national}`;
}

export const vendorApplicationRoutes = [
  vroute(
    "GET",
    "/vendor/geo",
    async () => {
      const sql = db();
      const [countries, areas] = await Promise.all([
        sql`
          select code, name, currency, currency_symbol as "currencySymbol", currency_decimals as "currencyDecimals",
                 timezone, dial_code as "dialCode", lat, lng
          from public.countries where active order by sort_order, code`,
        sql`
          select id, name, country_code as "countryCode", lat, lng
          from public.areas where active order by sort_order, id`,
      ]);
      return ok({ countries, areas });
    },
    true,
  ),

  vroute(
    "POST",
    "/vendor/applications",
    async ({ body }) => {
      const data = body as unknown as SubmitApplicationPayload & { countryCode?: string; dialCode?: string; customAreaName?: string };
      const businessName = requireText(data.businessName, "businessName", "اسم المغسلة", 2);
      const ownerName = requireText(data.ownerName, "ownerName", "اسم المالك", 2);
      const sql = db();
      const phoneE164 = await toE164(sql, String(data.phone ?? ""), data.dialCode);
      const rawEmail = String(data.email ?? "").trim();
      const email = rawEmail.includes("@") ? rawEmail : `${phoneE164.replace(/\D/g, "")}@partner.washup.app`;
      const countryCode = requireText(data.countryCode, "countryCode", "الدولة", 2).toUpperCase();
      const [country] = await sql<CountryPick[]>`
        select code, dial_code as "dialCode", currency_decimals as "currencyDecimals", active
        from public.countries where code = ${countryCode}`;
      if (!country?.active) throw new MockApiError("هذه الدولة غير متاحة للتسجيل", 422, { countryCode: ["دولة غير مفعّلة"] });
      const address = requireText(data.address, "address", "عنوان المغسلة", 5);
      const lat = Number(data.lat);
      const lng = Number(data.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0) || isLegacyDefaultPin(lat, lng)) {
        throw new MockApiError("حدد موقع الفرع على الخريطة — الموقع الافتراضي غير مقبول", 422, { lat: ["حرّك الدبوس"] });
      }
      const capacity = Math.max(1, Math.min(20, Number(data.capacity) || 4));

      const factor = 10 ** Number(country.currencyDecimals ?? 2);
      const services = Array.isArray(data.services) ? data.services : [];
      if (!services.length) throw new MockApiError("اختر خدمة واحدة على الأقل", 422, { services: ["مطلوبة"] });
      const priced = services.map((s) => {
        const price = Math.round((Number(s.price) || 0) * factor) / factor;
        if (!(price > 0)) throw new MockApiError("أدخل سعرًا أكبر من صفر لكل خدمة مختارة", 422, { price: ["سعر غير صالح"] });
        return {
          name: String(s.name || "غسيل خارجي").trim() || "غسيل خارجي",
          price,
          durationMin: Math.max(5, Number(s.durationMin) || 20),
        };
      });

      assertWorkingHours(data.workingHours);
      const workingHours = data.workingHours;

      const documents = (Array.isArray(data.documents) ? data.documents.map(String) : []).filter((d) => d && d !== "commercial_reg.pdf");
      if (!documents.length) throw new MockApiError("ارفع السجل التجاري أو البطاقة الضريبية", 422, { documents: ["السجل التجاري مطلوب"] });

      const customArea = String(data.customAreaName ?? "").trim();
      let area = String(data.area ?? "").trim();
      if (area === "other" || !area) {
        if (customArea.length < 2) throw new MockApiError("اكتب اسم المنطقة", 422, { area: ["المنطقة مطلوبة"] });
        area = `area_${Date.now().toString(36)}`;
        await sql`
          insert into public.areas (id, name, country_code, lat, lng, active, sort_order)
          values (${area}, ${sql.json({ ar: customArea, en: customArea })}, ${countryCode}, ${lat}, ${lng}, false, 99)`;
      } else {
        const [known] = await sql<{ id: string }[]>`
          select id from public.areas where id = ${area} and country_code = ${countryCode} and active`;
        if (!known) throw new MockApiError("المنطقة لا تتبع الدولة المختارة", 422, { area: ["منطقة غير صالحة"] });
      }
      const id = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      await sql`
        insert into public.wash_applications (
          id, business_name, owner_name, phone, email, area_id, address, lat, lng,
          capacity, services, working_hours, documents, status, submitted_at
        ) values (
          ${id}, ${businessName}, ${ownerName}, ${phoneE164}, ${email}, ${area}, ${address}, ${lat}, ${lng},
          ${capacity}, ${sql.json(priced as any)}, ${sql.json(workingHours as any)}, ${documents}, 'pending', now()
        )
      `;

      await pushAdminNotification(
        sql,
        "application",
        { ar: "طلب انضمام جديد", en: "New wash application" },
        {
          ar: `قدمت مغسلة ${businessName} (${ownerName}) طلب انضمام جديد.`,
          en: `Wash ${businessName} submitted an application.`,
        },
        `/applications/${id}`,
      );

      const [app] = await applicationsWhere(sql, sql`ap.id = ${id}`);
      return ok(app, "تم تقديم طلب الانضمام بنجاح وسيتواصل معك فريق Wash Up قريبًا");
    },
    true,
  ),

  vroute(
    "GET",
    "/vendor/applications/:id",
    async ({ params }) => {
      const sql = db();
      const target = String(params.id ?? "").trim();
      let app: any;

      if (target.startsWith("app_")) {
        [app] = await applicationsWhere(sql, sql`ap.id = ${target}`);
      } else {
        const digits = target.replace(/\D/g, "");
        if (digits.length >= 8) {
          [app] = await applicationsWhere(
            sql,
            sql`regexp_replace(ap.phone, '\\D', '', 'g') = ${digits}`,
            sql`order by ap.submitted_at desc limit 1`
          );
        }
      }

      if (!app) throw new MockApiError("طلب الانضمام غير موجود", 404);
      return ok(app);
    },
    true,
  ),
];
