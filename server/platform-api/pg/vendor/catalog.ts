import "server-only";

import type { Offer } from "@/types/offers";
import type { VendorBranch, VendorNotificationType, VendorOffer, VendorService, VendorSettings } from "@/types/vendor/catalog";
import type { BranchSettings, ServiceType, WorkingDay } from "@/types/washes";

import { daysAgo, now } from "../../db";
import { MockApiError, ok, requireText } from "../../http";
import type { VendorActor } from "../../router";
import { defaultPermissions } from "../../seed";
import { DEFAULT_NOTIFICATION_PREFS } from "../../vendor/notify";
import { BRANCH_COLS, SERVICE_COLS, branchById, e164, offersWhere, servicesWhere } from "../entities";
import { dayBounds, searchPattern } from "../list";
import { defaultCommissionPct, logAudit, pushAdminNotification, vendorSettingsFor } from "../platform";
import { vroute } from "../router";
import { type Q, db, tx } from "../sql";
import { assertBranch, assertOwner, inScope, scopeBranches } from "./scope";

/**
 * Vendor catalog on Postgres: services (D8), wash offers (D9), branches and
 * booking rules (D16 / OW-12), wash settings (D19). Same routes, rules,
 * messages and audit entries as `../../vendor/catalog.ts`.
 */

const CATEGORIES = ["exterior", "interior", "full", "deep"];
const OFFER_STATUSES = ["draft", "scheduled", "active", "expired", "disabled"] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function audit(q: Q, actor: VendorActor, action: string, entity: string, entityId: string, branchId: string | null, oldValue: unknown, newValue: unknown, reason?: string | null) {
  return logAudit(q, { actorType: "staff", actorId: actor.staff.id, action, entity, entityId, branchId, oldValue, newValue, reason: reason ?? null });
}

async function canEditServices(q: Q, actor: VendorActor) {
  return actor.role === "owner" || (await vendorSettingsFor(q, actor.business.id)).managerCanEditServices;
}

function deriveOfferStatus(o: Pick<Offer, "status" | "startAt" | "endAt">): Offer["status"] {
  if (o.status === "draft" || o.status === "disabled") return o.status;
  const t = now().getTime();
  if (new Date(o.endAt).getTime() < t) return "expired";
  if (new Date(o.startAt).getTime() > t) return "scheduled";
  return "active";
}

/** SQL twin of `deriveOfferStatus` (alias of), evaluated at `at`. */
const LIVE_OFFER_STATUS = (q: Q, at: string) => q`
  case when of.status in ('draft', 'disabled') then of.status::text
       when of.ends_at < ${at} then 'expired'
       when of.starts_at > ${at} then 'scheduled'
       else 'active' end`;

function parseServiceBody(body: Record<string, unknown>) {
  const name = (body.name ?? {}) as { ar?: string; en?: string };
  const description = (body.description ?? {}) as { ar?: string; en?: string };
  const nameAr = requireText(name.ar, "name.ar", "اسم الخدمة بالعربية", 2);
  const nameEn = requireText(name.en, "name.en", "اسم الخدمة بالإنجليزية", 2);
  const price = Number(body.price);
  const durationMin = Number(body.durationMin);
  if (Number.isNaN(price) || price < 10 || price > 5000) throw new MockApiError("السعر يجب أن يكون بين 10 و 5000 ج.م", 422, { price: ["قيمة غير صالحة"] });
  if (Number.isNaN(durationMin) || durationMin < 2 || durationMin > 240) throw new MockApiError("المدة بين 2 و 240 دقيقة", 422, { durationMin: ["قيمة غير صالحة"] });
  const type: ServiceType = body.type === "addon" ? "addon" : "primary";
  const category = CATEGORIES.includes(String(body.category)) ? String(body.category) : "exterior";
  return {
    name: { ar: nameAr, en: nameEn },
    description: { ar: String(description.ar ?? "").trim(), en: String(description.en ?? "").trim() },
    price: Math.round(price),
    durationMin: Math.round(durationMin),
    type,
    category,
    active: body.active !== false,
  };
}

function parseOffer(actor: VendorActor, body: Record<string, unknown>) {
  const title = (body.title ?? {}) as { ar?: string; en?: string };
  const description = (body.description ?? {}) as { ar?: string; en?: string };
  const discountType = body.discountType === "fixed" ? "fixed" : "percent";
  const discountValue = Number(body.discountValue);
  if (Number.isNaN(discountValue) || discountValue <= 0) throw new MockApiError("قيمة الخصم غير صالحة", 422);
  if (discountType === "percent" && discountValue > 50) throw new MockApiError("الحد الأقصى للخصم ٥٠٪", 422);
  const startAt = new Date(String(body.startAt));
  const endAt = new Date(String(body.endAt));
  if (Number.isNaN(+startAt) || Number.isNaN(+endAt) || endAt <= startAt) throw new MockApiError("تاريخ النهاية يجب أن يكون بعد البداية", 422);
  const branchIds = Array.isArray(body.branchIds) ? body.branchIds.map(String).filter((b) => actor.branchIds.includes(b)) : [];
  if (!branchIds.length) throw new MockApiError("اختر فرعًا واحدًا على الأقل", 422);
  return {
    title: { ar: requireText(title.ar, "title.ar", "عنوان العرض", 3), en: String(title.en ?? "").trim() || String(title.ar) },
    description: { ar: String(description.ar ?? "").trim(), en: String(description.en ?? "").trim() },
    discountType: discountType as Offer["discountType"],
    discountValue,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    branchIds: [...new Set(branchIds)],
    serviceCategories: Array.isArray(body.serviceCategories)
      ? [...new Set(body.serviceCategories.map(String).filter((c) => CATEGORIES.includes(c)))]
      : [],
  };
}

/** Replaces an offer's branches and categories (delete + insert, inside the caller's transaction). */
async function replaceOfferTargets(t: Q, offerId: string, branchIds: string[], categories: string[]) {
  await t`delete from public.offer_branches where offer_id = ${offerId}`;
  await t`delete from public.offer_categories where offer_id = ${offerId}`;
  await t`insert into public.offer_branches (offer_id, branch_id) select ${offerId}, b from unnest(${branchIds}::text[]) as b`;
  if (categories.length) {
    await t`insert into public.offer_categories (offer_id, category_id) select ${offerId}, c from unnest(${categories}::text[]) as c`;
  }
}

/** The wash's own offer (scope wash), or a 404 with the given message. */
async function ownOffer(q: Q, actor: VendorActor, id: string, notFound: string): Promise<Offer> {
  const [offer] = await offersWhere(q, q`of.id = ${id} and of.business_id = ${actor.business.id} and of.scope = 'wash'`);
  if (!offer) throw new MockApiError(notFound, 404);
  return offer;
}

export const vendorCatalogRoutes = [
  // ── Services (D8) ───────────────────────────────────────
  vroute("GET", "/vendor/services", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const type = query.get("type");
    const search = searchPattern(query);
    const from = daysAgo(29).toISOString();

    const [list, canEdit] = await Promise.all([
      sql<VendorService[]>`
        select ${sql.unsafe(SERVICE_COLS)}, br.name as "branchName",
          coalesce(sv.description, case when sv.type = 'addon'
            then '{"ar": "إضافة اختيارية على الخدمة الأساسية.", "en": ""}'::jsonb
            else '{"ar": "خدمة غسيل بمعايير كارزن.", "en": ""}'::jsonb end) as description,
          us."ordersCount", us."revenue30d"
        from public.services sv
        join public.branches br on br.id = sv.branch_id
        cross join lateral (
          -- One row per order (first line of this service), like the mock's items.find().
          select count(*)::int as "ordersCount",
                 coalesce(sum(x.price) filter (where x.payment_status = 'paid' and x.scheduled_at >= ${from}), 0) as "revenue30d"
          from (select distinct on (i.order_id) i.price, o.payment_status, o.scheduled_at
                from public.order_items i join public.orders o on o.id = i.order_id
                where i.service_id = sv.id order by i.order_id, i.position) x) us
        where sv.branch_id = any(${branchIds})
          ${type && type !== "all" ? sql`and sv.type::text = ${type}` : sql``}
          ${search ? sql`and (sv.name ->> 'ar' ilike ${search} or sv.name ->> 'en' ilike ${search})` : sql``}
        order by sv.branch_id, (sv.type <> 'primary'), sv.price, sv.id`,
      canEditServices(sql, actor),
    ]);
    return ok(list, "OK", { meta: { canEdit } });
  }),

  vroute("POST", "/vendor/services", async ({ body, actor }) => {
    const { service, data } = await tx(async (t) => {
      if (!(await canEditServices(t, actor))) throw new MockApiError("تعديل الخدمات متاح للمالك فقط (أو لمدير مُصرّح له)", 403);
      const branchId = String(body.branchId ?? "");
      assertBranch(actor, branchId);
      const data = parseServiceBody(body);
      const [{ id }] = await t<{ id: string }[]>`
        insert into public.services (branch_id, type, category_id, name, description, price, duration_min, active)
        values (${branchId}, ${data.type}, ${data.category}, ${t.json(data.name)}, ${t.json(data.description)},
                ${data.price}, ${data.durationMin}, ${data.active})
        returning id`;
      await audit(t, actor, "service.create", "services", id, branchId, null, `${data.name.ar} · ${data.price} ج.م · ${data.durationMin} د`);
      const [service] = await servicesWhere(t, t`sv.id = ${id}`);
      return { service, data };
    });
    return ok(service, `تمت إضافة «${data.name.ar}» — تظهر للعملاء فورًا`);
  }),

  vroute("PATCH", "/vendor/services/:id", async ({ params, body, actor }) => {
    const { service, before, priceChanged } = await tx(async (t) => {
      if (!(await canEditServices(t, actor))) throw new MockApiError("تعديل الخدمات متاح للمالك فقط (أو لمدير مُصرّح له)", 403);
      const [row] = await servicesWhere(t, t`sv.id = ${params.id}`);
      const svc = inScope(actor, row, "الخدمة");
      const data = parseServiceBody(body);
      const before = { name: svc.name.ar, price: svc.price, durationMin: svc.durationMin, active: svc.active };
      const priceChanged = data.price !== svc.price;
      if (!data.active && svc.active && svc.type === "primary") {
        const [{ n }] = await t<{ n: number }[]>`
          select count(*)::int as n from public.services
          where branch_id = ${svc.branchId} and type = 'primary' and active and id <> ${svc.id}`;
        if (!n) throw new MockApiError("لا يمكن إيقاف آخر خدمة أساسية مفعّلة في الفرع", 409);
      }
      await t`
        update public.services set name = ${t.json(data.name)}, description = ${t.json(data.description)}, price = ${data.price},
               duration_min = ${data.durationMin}, type = ${data.type}, category_id = ${data.category}, active = ${data.active}
        where id = ${svc.id}`;
      const [service] = await servicesWhere(t, t`sv.id = ${svc.id}`);
      await audit(
        t, actor, priceChanged ? "service.price_change" : "service.update", "services", svc.id, svc.branchId,
        before, { name: service.name.ar, price: service.price, durationMin: service.durationMin, active: service.active },
        typeof body.reason === "string" ? body.reason : null,
      );
      return { service, before, priceChanged };
    });
    return ok(service, priceChanged ? `تم تحديث السعر (${before.price} ← ${service.price} ج.م) — يُطبق على الطلبات الجديدة فقط` : "تم حفظ الخدمة");
  }),

  // ── Wash offers (D9) ─────────────────────────────────────
  vroute("GET", "/vendor/offers", async ({ query, actor }) => {
    const sql = db();
    const branchIds = scopeBranches(actor, query.get("branchId"));
    const status = query.get("status");
    const search = searchPattern(query);
    const at = now().toISOString();

    const base = sql`
      select of.id, of.scope, of.business_id as "businessId",
        coalesce((select json_agg(ob.branch_id order by ob.branch_id) from public.offer_branches ob
                  where ob.offer_id = of.id and ob.branch_id = any(${actor.branchIds})), '[]') as "branchIds",
        coalesce((select json_agg(oc.category_id order by oc.category_id) from public.offer_categories oc where oc.offer_id = of.id), '[]') as "serviceCategories",
        of.title, of.description, of.discount_type as "discountType", of.discount_value as "discountValue",
        of.starts_at as "startAt", of.ends_at as "endAt", ${LIVE_OFFER_STATUS(sql, at)} as status,
        (of.scope = 'wash' and of.business_id = ${actor.business.id}) as editable,
        (select count(*)::int from public.orders x where x.offer_id = of.id and x.branch_id = any(${actor.branchIds})) as redemptions
      from public.offers of
      where (of.business_id = ${actor.business.id}
             or (of.scope = 'platform' and exists (select 1 from public.offer_branches ob where ob.offer_id = of.id and ob.branch_id = any(${branchIds}))))
        ${search ? sql`and (of.title ->> 'ar' ilike ${search} or of.title ->> 'en' ilike ${search})` : sql``}`;
    const filter = status && status !== "all" ? sql`where w.status = ${status}` : sql``;

    // Counts are computed before the status filter so every tab shows its real total.
    const [countRows, items] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w.status as k, count(*)::int as n from w group by w.status`,
      sql<VendorOffer[]>`with w as (${base}) select * from w ${filter} order by w."startAt" desc, w.id`,
    ]);
    const counts = Object.fromEntries(OFFER_STATUSES.map((s) => [s, countRows.find((r) => r.k === s)?.n ?? 0]));
    return ok(items, "OK", { meta: { counts } });
  }),

  vroute("POST", "/vendor/offers", async ({ body, actor }) => {
    assertOwner(actor, "إدارة العروض");
    const offer = await tx(async (t) => {
      const data = parseOffer(actor, body);
      const status = deriveOfferStatus({ status: body.publish ? "active" : "draft", startAt: data.startAt, endAt: data.endAt });
      const [{ id }] = await t<{ id: string }[]>`
        insert into public.offers (scope, business_id, title, description, discount_type, discount_value, starts_at, ends_at, status, featured)
        values ('wash', ${actor.business.id}, ${t.json(data.title)}, ${t.json(data.description)}, ${data.discountType}, ${data.discountValue},
                ${data.startAt}, ${data.endAt}, ${status}, false)
        returning id`;
      await replaceOfferTargets(t, id, data.branchIds, data.serviceCategories);
      await audit(t, actor, "offer.create", "offers", id, null, null, `${data.title.ar} · ${status}`);
      return ownOffer(t, actor, id, "العرض غير موجود");
    });
    return ok(offer, offer.status === "draft" ? "تم حفظ العرض كمسودة" : "تم نشر العرض — يطبقه التسعير تلقائيًا");
  }),

  vroute("PATCH", "/vendor/offers/:id", async ({ params, body, actor }) => {
    assertOwner(actor, "إدارة العروض");
    const offer = await tx(async (t) => {
      const current = await ownOffer(t, actor, params.id, "العرض غير موجود أو غير قابل للتعديل");
      const data = parseOffer(actor, body);
      const before = { title: current.title.ar, discount: current.discountValue };
      const status = deriveOfferStatus({
        status: body.publish && current.status === "draft" ? "active" : current.status,
        startAt: data.startAt,
        endAt: data.endAt,
      });
      await t`
        update public.offers set title = ${t.json(data.title)}, description = ${t.json(data.description)}, discount_type = ${data.discountType},
               discount_value = ${data.discountValue}, starts_at = ${data.startAt}, ends_at = ${data.endAt}, status = ${status}
        where id = ${current.id}`;
      await replaceOfferTargets(t, current.id, data.branchIds, data.serviceCategories);
      await audit(t, actor, "offer.update", "offers", current.id, null, before, { title: data.title.ar, discount: data.discountValue });
      return ownOffer(t, actor, current.id, "العرض غير موجود");
    });
    return ok(offer, "تم تحديث العرض");
  }),

  vroute("POST", "/vendor/offers/:id/status", async ({ params, body, actor }) => {
    assertOwner(actor, "إدارة العروض");
    const enable = Boolean(body.enabled);
    const offer = await tx(async (t) => {
      const current = await ownOffer(t, actor, params.id, "العرض غير موجود");
      const old = deriveOfferStatus(current);
      const status = deriveOfferStatus({ ...current, status: enable ? "active" : "disabled" });
      await t`update public.offers set status = ${status} where id = ${current.id}`;
      await audit(t, actor, enable ? "offer.enable" : "offer.disable", "offers", current.id, null, old, status);
      return ownOffer(t, actor, current.id, "العرض غير موجود");
    });
    return ok(offer, enable ? "تم تفعيل العرض" : "تم إيقاف العرض");
  }),

  // ── Branches (D16) & booking rules (OW-12) ───────────────
  vroute("GET", "/vendor/branches", async ({ actor }) => {
    const sql = db();
    const at = now();
    const [todayStart, todayEnd] = dayBounds(at);
    const list = await sql<VendorBranch[]>`
      select ${sql.unsafe(BRANCH_COLS)},
        (select count(*)::int from public.orders o where o.branch_id = br.id and o.scheduled_at >= ${todayStart} and o.scheduled_at < ${todayEnd}) as "todayOrders",
        (select count(*)::int from public.orders o where o.branch_id = br.id and o.status in ('pending', 'confirmed')
                and o.scheduled_at > ${at.toISOString()}) as "upcomingOrders",
        (select count(*)::int from public.services s where s.branch_id = br.id and s.active) as "servicesCount",
        (select count(*)::int from public.staff s where s.branch_id = br.id and s.role <> 'owner' and s.status = 'active') as "staffCount"
      from public.branches br
      where br.id = any(${actor.branchIds})
      order by array_position(${actor.branchIds}::text[], br.id)`;
    return ok(list);
  }),

  vroute("PATCH", "/vendor/branches/:id", async ({ params, body, actor }) => {
    assertOwner(actor, "تعديل بيانات الفرع");
    const { branch, deactivating, upcoming } = await tx(async (t) => {
      if (!actor.branchIds.includes(params.id)) throw new MockApiError("الفرع غير موجود", 404);
      const target = await branchById(t, params.id, "الفرع");
      const reason = requireText(body.reason, "reason", "سبب التعديل", 3);
      const name = (body.name ?? {}) as { ar?: string; en?: string };
      const address = (body.address ?? {}) as { ar?: string; en?: string };
      const capacity = Number(body.capacity);
      if (Number.isNaN(capacity) || capacity < 1 || capacity > 30) throw new MockApiError("السعة بين 1 و 30 مكان", 422, { capacity: ["قيمة غير صالحة"] });
      const hours = Array.isArray(body.workingHours) ? (body.workingHours as WorkingDay[]) : target.workingHours;
      if (hours.length !== 7) throw new MockApiError("ساعات العمل يجب أن تغطي 7 أيام", 422);
      const workingHours = hours.map((d) => ({ open: String(d.open), close: String(d.close), closed: Boolean(d.closed) }));
      // The database stores real times: reject what the mock would have kept as free text.
      if (workingHours.some((d) => !HHMM.test(d.open) || !HHMM.test(d.close))) throw new MockApiError("صيغة الوقت غير صحيحة", 422);
      const before = { name: target.name.ar, capacity: target.capacity, active: target.active };
      const deactivating = target.active && body.active === false;

      const next = {
        name: { ar: requireText(name.ar, "name.ar", "اسم الفرع", 2), en: String(name.en ?? target.name.en).trim() || target.name.en },
        address: { ar: requireText(address.ar, "address.ar", "العنوان", 3), en: String(address.en ?? target.address.en).trim() || target.address.en },
        phone: e164(String(body.phone ?? target.phone).trim()),
        amenities: Array.isArray(body.amenities) ? [...new Set(body.amenities.map(String))] : target.amenities,
        capacity: Math.round(capacity),
        active: body.active !== false,
      };
      await t`
        update public.branches set name = ${t.json(next.name)}, address = ${t.json(next.address)}, phone = ${next.phone},
               capacity = ${next.capacity}, active = ${next.active}
        where id = ${target.id}`;
      await t`delete from public.branch_amenities where branch_id = ${target.id}`;
      if (next.amenities.length) {
        await t`insert into public.branch_amenities (branch_id, amenity_id) select ${target.id}, a from unnest(${next.amenities}::text[]) as a`;
      }
      await t`delete from public.branch_working_hours where branch_id = ${target.id}`;
      await t`
        insert into public.branch_working_hours ${t(
          workingHours.map((d, weekday) => ({ branch_id: target.id, weekday, opens_at: d.open, closes_at: d.close, closed: d.closed })),
          "branch_id", "weekday", "opens_at", "closes_at", "closed",
        )}`;

      await audit(t, actor, "branch.update", "branches", target.id, target.id, before, { name: next.name.ar, capacity: next.capacity, active: next.active }, reason);
      let upcoming = 0;
      if (deactivating) {
        await pushAdminNotification(
          t,
          "unusual_activity",
          { ar: "فرع أوقفه المالك", en: "Branch deactivated by owner" },
          { ar: `${next.name.ar} — ${reason}`, en: next.name.en },
          `/washes/${actor.business.id}`,
        );
        const [{ n }] = await t<{ n: number }[]>`
          select count(*)::int as n from public.orders
          where branch_id = ${target.id} and status in ('pending', 'confirmed') and scheduled_at > ${now().toISOString()}`;
        upcoming = n;
      }
      return { branch: await branchById(t, target.id), deactivating, upcoming };
    });
    if (deactivating) {
      return ok(branch, upcoming ? `تم إيقاف الفرع — تنبيه: يوجد ${upcoming} حجز قادم لم يُلغ` : "تم إيقاف الفرع وإخفاؤه من تطبيق العميل");
    }
    return ok(branch, "تم حفظ بيانات الفرع");
  }),

  vroute("PUT", "/vendor/branches/:id/settings", async ({ params, body, actor }) => {
    assertOwner(actor, "تعديل قواعد الحجز");
    const branch = await tx(async (t) => {
      if (!actor.branchIds.includes(params.id)) throw new MockApiError("الفرع غير موجود", 404);
      const target = await branchById(t, params.id, "الفرع");
      const reason = requireText(body.reason, "reason", "سبب التعديل", 3);
      const s = (body.settings ?? {}) as Partial<BranchSettings>;
      const num = (v: unknown, min: number, max: number, label: string) => {
        const n = Number(v);
        if (Number.isNaN(n) || n < min || n > max) throw new MockApiError(`${label} بين ${min} و ${max}`, 422);
        return Math.round(n);
      };
      const next: BranchSettings = {
        autoConfirm: Boolean(s.autoConfirm),
        slotIntervalMin: [15, 20, 30, 45, 60].includes(Number(s.slotIntervalMin)) ? Number(s.slotIntervalMin) : 30,
        leadTimeMin: num(s.leadTimeMin, 0, 240, "مهلة الحجز"),
        maxAdvanceDays: num(s.maxAdvanceDays, 1, 30, "أقصى أيام مسبقة"),
        freeCancelMin: num(s.freeCancelMin, 0, 1440, "نافذة الإلغاء المجاني"),
        noShowGraceMin: num(s.noShowGraceMin, 5, 120, "مهلة عدم الحضور"),
        reminderMin: num(s.reminderMin, 5, 1440, "توقيت التذكير"),
      };
      await t`
        update public.branches set auto_confirm = ${next.autoConfirm}, slot_interval_min = ${next.slotIntervalMin},
               lead_time_min = ${next.leadTimeMin}, max_advance_days = ${next.maxAdvanceDays}, free_cancel_min = ${next.freeCancelMin},
               no_show_grace_min = ${next.noShowGraceMin}, reminder_min = ${next.reminderMin}
        where id = ${target.id}`;
      await audit(t, actor, "branch.rules", "branches", target.id, target.id, target.settings, next, reason);
      return branchById(t, target.id);
    });
    return ok(branch, "تم حفظ قواعد الحجز — تنعكس في تطبيق العميل فورًا");
  }),

  // ── Settings (D19) ───────────────────────────────────────
  vroute("GET", "/vendor/settings", async ({ actor }) => {
    const sql = db();
    const [s, defaultRate] = await Promise.all([vendorSettingsFor(sql, actor.business.id), defaultCommissionPct(sql)]);
    const data: VendorSettings = {
      business: {
        id: actor.business.id,
        name: actor.business.name,
        ownerName: actor.business.ownerName,
        phone: s.phone,
        email: s.email,
        commissionRate: actor.business.commissionRate ?? defaultRate,
        status: actor.business.status,
      },
      managerCanEditServices: s.managerCanEditServices,
      notificationPrefs: { ...DEFAULT_NOTIFICATION_PREFS, ...s.notificationPrefs },
      roleMatrix: (["owner", "manager", "employee"] as const).map((role) => ({
        role,
        permissions: defaultPermissions(role),
        maxDiscountPct: role === "owner" ? 100 : role === "manager" ? 20 : 10,
      })),
    };
    return ok(data);
  }),

  vroute("PUT", "/vendor/settings", async ({ body, actor }) => {
    assertOwner(actor, "تعديل إعدادات المغسلة");
    await tx(async (t) => {
      const reason = requireText(body.reason, "reason", "سبب التعديل", 3);
      const s = await vendorSettingsFor(t, actor.business.id);
      // Owner-level settings row (created on first save, like the mock's lazy default).
      await t`insert into public.business_settings (business_id) values (${actor.business.id}) on conflict (business_id) do nothing`;
      const changes: string[] = [];
      if (body.business && typeof body.business === "object") {
        const b = body.business as { name?: { ar?: string; en?: string }; phone?: string; email?: string };
        const nameAr = requireText(b.name?.ar, "name.ar", "اسم المغسلة", 2);
        const email = String(b.email ?? "").trim();
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new MockApiError("صيغة البريد غير صحيحة", 422, { email: ["صيغة غير صحيحة"] });
        const name = { ar: nameAr, en: String(b.name?.en ?? "").trim() || actor.business.name.en };
        const phone = String(b.phone ?? s.phone).trim();
        await t`update public.businesses set name = ${t.json(name)} where id = ${actor.business.id}`;
        await t`
          update public.business_settings set contact_phone = ${phone ? e164(phone) : null}, contact_email = ${email || null}
          where business_id = ${actor.business.id}`;
        changes.push("business");
      }
      if (typeof body.managerCanEditServices === "boolean") {
        await t`update public.business_settings set manager_can_edit_services = ${body.managerCanEditServices} where business_id = ${actor.business.id}`;
        changes.push("managerCanEditServices");
      }
      if (body.notificationPrefs && typeof body.notificationPrefs === "object") {
        const prefs = { ...DEFAULT_NOTIFICATION_PREFS, ...(body.notificationPrefs as Record<VendorNotificationType, boolean>) };
        await t`update public.business_settings set notification_prefs = ${t.json(prefs)} where business_id = ${actor.business.id}`;
        changes.push("notificationPrefs");
      }
      if (!changes.length) throw new MockApiError("لا توجد تغييرات للحفظ", 422);
      await audit(t, actor, "settings.update", "settings", actor.business.id, null, null, changes.join(", "), reason);
    });
    return ok(null, "تم حفظ الإعدادات");
  }),
];
