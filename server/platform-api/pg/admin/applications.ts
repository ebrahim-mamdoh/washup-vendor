import "server-only";

import type { ApplicationStatus, WashApplication } from "@/types/applications";

import { MockApiError, ok, requireText } from "../../http";
import { defaultPermissions } from "../../seed";
import { DEFAULT_NOTIFICATION_PREFS } from "../../vendor/notify";
import { PHONE, applicationsWhere } from "../entities";
import { countsOf, orderBy, paged, searchPattern } from "../list";
import { logAudit, pushAdminNotification, pushVendorNotification } from "../platform";
import { route } from "../router";
import { type Q, db, tx } from "../sql";

const STATUSES: ApplicationStatus[] = ["pending", "needs_changes", "approved", "rejected"];

const CATEGORY_BY_NAME: Record<string, string> = {
  "غسيل خارجي": "exterior",
  "غسيل داخلي": "interior",
  "غسيل داخلي وخارجي": "full",
  "تنظيف عميق (بخار)": "deep",
};

const DECIDED = "تم اتخاذ قرار في هذا الطلب مسبقًا";

async function applicationById(q: Q, id: string): Promise<WashApplication> {
  const [app] = await applicationsWhere(q, q`ap.id = ${id}`);
  if (!app) throw new MockApiError("الطلب غير موجود", 404);
  return app;
}

/** Booking defaults (Settings → booking) a new branch starts with, like the mock `{ ...settings.bookingDefaults }`. */
async function bookingDefaults(q: Q) {
  const [row] = await q<{ value: Record<string, unknown> }[]>`select value from public.platform_settings where key = 'booking_defaults'`;
  const v = row?.value ?? {};
  const num = (k: string, fallback: number) => (v[k] === undefined || v[k] === null ? fallback : Number(v[k]));
  return {
    autoConfirm: Boolean(v.autoConfirm ?? false),
    slotIntervalMin: num("slotIntervalMin", 30),
    leadTimeMin: num("leadTimeMin", 60),
    maxAdvanceDays: num("maxAdvanceDays", 7),
    freeCancelMin: num("freeCancelMin", 120),
    noShowGraceMin: num("noShowGraceMin", 15),
    reminderMin: num("reminderMin", 60),
  };
}

export const applicationRoutes = [
  route("GET", "/admin/applications", async ({ query }) => {
    const sql = db();
    const status = query.get("status");
    const search = searchPattern(query);

    const searched = search
      ? sql`(ap.business_name ilike ${search} or ap.owner_name ilike ${search}
             or ${sql.unsafe(PHONE("ap.phone"))} ilike ${search} or ap.email ilike ${search})`
      : sql`true`;
    const filtered = status && status !== "all" ? sql`${searched} and ap.status::text = ${status}` : searched;

    const [countRows, [{ total }], [pipe]] = await Promise.all([
      sql<{ k: string; n: number }[]>`
        select ap.status::text as k, count(*)::int as n from public.wash_applications ap where ${searched} group by ap.status`,
      sql<{ total: number }[]>`select count(*)::int as total from public.wash_applications ap where ${filtered}`,
      sql<{ submitted: number; onboarding: number; active: number }[]>`
        select (select count(*)::int from public.wash_applications) as submitted,
               (select count(*)::int from public.businesses where status = 'approved') as onboarding,
               (select count(*)::int from public.businesses where status = 'active') as active`,
    ]);
    const counts = countsOf(countRows, STATUSES);

    // Review queue is FIFO: oldest submission first.
    const sort = orderBy(
      sql,
      query,
      { submittedAt: "ap.submitted_at", name: `ap.business_name collate "C"` },
      { key: "submittedAt", order: "asc" },
      "ap.id",
    );
    const { items, pagination } = await paged(query, total, 20, (limit, offset) =>
      applicationsWhere(sql, filtered, sql`${sort} limit ${limit} offset ${offset}`),
    );

    const pipeline = {
      submitted: pipe.submitted,
      pendingReview: counts.pending + counts.needs_changes,
      approved: counts.approved,
      onboarding: pipe.onboarding,
      active: pipe.active,
    };
    return ok(items, "OK", { pagination, meta: { counts, pipeline } });
  }),

  route("GET", "/admin/applications/:id", async ({ params }) => ok(await applicationById(db(), params.id))),

  route("POST", "/admin/applications/:id/approve", async ({ params, body, admin }) => {
    const result = await tx(async (t) => {
      const app = await applicationById(t, params.id);
      if (app.status === "approved" || app.status === "rejected") throw new MockApiError(DECIDED, 409);
      const checklist = Array.isArray(body.checklist) ? body.checklist.map(String) : [];
      if (checklist.length < 6) throw new MockApiError("أكمل قائمة التحقق قبل الموافقة", 422);
      const activate = body.activateImmediately !== false;
      const note = typeof body.note === "string" ? body.note.trim() : "";

      // Raw application row: phone is already E.164 there (the contract shows the display format).
      const [raw] = await t<{ phone: string }[]>`select phone from public.wash_applications where id = ${app.id}`;
      // staff.phone is unique: the owner signs in with it.
      const [taken] = await t`select 1 from public.staff where phone = ${raw.phone}`;
      if (taken) {
        throw new MockApiError("رقم هاتف المالك مسجّل بالفعل لحساب آخر في كارزن", 409, {
          phone: ["رقم الهاتف مستخدم بالفعل"],
        });
      }

      const name = { ar: app.businessName, en: app.businessName };
      const [biz] = await t<{ id: string }[]>`
        insert into public.businesses (name, status, status_reason, commission_rate, rating)
        values (${t.json(name)}, ${activate ? "active" : "approved"}, null, null, 0)
        returning id`;

      const settings = await bookingDefaults(t);
      const [branch] = await t<{ id: string }[]>`
        insert into public.branches (business_id, name, area_id, address, lat, lng, phone, capacity, active, featured,
                                     auto_confirm, slot_interval_min, lead_time_min, max_advance_days, free_cancel_min,
                                     no_show_grace_min, reminder_min)
        values (${biz.id}, ${t.json(name)}, ${app.area}, ${t.json({ ar: app.address, en: app.address })}, ${app.lat}, ${app.lng},
                ${raw.phone}, ${app.capacity}, true, false,
                ${settings.autoConfirm}, ${settings.slotIntervalMin}, ${settings.leadTimeMin}, ${settings.maxAdvanceDays},
                ${settings.freeCancelMin}, ${settings.noShowGraceMin}, ${settings.reminderMin})
        returning id`;

      const hours = app.workingHours.map((d, weekday) => ({ weekday, open: d.open, close: d.close, closed: Boolean(d.closed) }));
      if (hours.length) {
        await t`
          insert into public.branch_working_hours (branch_id, weekday, opens_at, closes_at, closed)
          select ${branch.id}, h.weekday, h.open::time, h.close::time, h.closed
          from jsonb_to_recordset(${t.json(hours)}::jsonb) as h(weekday smallint, open text, close text, closed boolean)`;
      }
      await t`
        insert into public.branch_amenities (branch_id, amenity_id)
        select ${branch.id}, a from unnest(${["waiting", "card"]}::text[]) as a`;

      const services = app.services.map((s) => ({
        category: CATEGORY_BY_NAME[s.name] ?? "exterior",
        name: { ar: s.name, en: s.name },
        price: s.price,
        durationMin: s.durationMin,
      }));
      if (services.length) {
        await t`
          insert into public.services (branch_id, type, category_id, name, price, duration_min, active)
          select ${branch.id}, 'primary', s.category, s.name, s.price, s."durationMin", true
          from jsonb_to_recordset(${t.json(services)}::jsonb) as s(category text, name jsonb, price numeric, "durationMin" smallint)`;
      }

      const [owner] = await t<{ id: string }[]>`
        insert into public.staff (business_id, branch_id, name, phone, role, status, max_discount_pct, permissions)
        values (${biz.id}, ${branch.id}, ${app.ownerName}, ${raw.phone}, 'owner', 'active', 100, ${t.json({ ...defaultPermissions("owner") })})
        returning id`;
      // businesses.owner_staff_id is a deferrable FK: checked at commit, after the staff row exists.
      await t`update public.businesses set owner_staff_id = ${owner.id} where id = ${biz.id}`;

      // The owner's contact details seed the wash's vendor settings (Settings → contact).
      await t`
        insert into public.business_settings (business_id, contact_phone, contact_email, notification_prefs)
        values (${biz.id}, ${raw.phone}, ${app.email || null}, ${t.json(DEFAULT_NOTIFICATION_PREFS)})
        on conflict (business_id) do update set contact_phone = excluded.contact_phone, contact_email = excluded.contact_email`;

      await pushVendorNotification(
        t,
        biz.id,
        null,
        "platform",
        "مرحبًا بك في كارزن 🎉",
        activate
          ? "تمت الموافقة على مغسلتك وأصبحت ظاهرة للعملاء. أكمل خطوات الإعداد لتبدأ في استقبال الحجوزات."
          : "تمت الموافقة على مغسلتك. أكمل خطوات الإعداد ليتم تفعيلها للعملاء.",
        "/dashboard",
      );

      const updated = await t`
        update public.wash_applications
        set status = 'approved', review_note = ${note || null}, reviewed_at = now(), business_id = ${biz.id}
        where id = ${app.id} and status in ('pending', 'needs_changes')
        returning id`;
      if (!updated.length) throw new MockApiError(DECIDED, 409);

      await logAudit(t, {
        actorId: admin.id,
        action: "approve_application",
        entity: "applications",
        entityId: app.id,
        oldValue: app.status,
        newValue: activate ? "approved → active" : "approved",
        reason: note || `تمت الموافقة وإنشاء المغسلة ${app.businessName}`,
      });
      await pushAdminNotification(
        t,
        "application",
        { ar: "تمت الموافقة على مغسلة جديدة", en: "New wash approved" },
        {
          ar: `${app.businessName} أصبحت ${activate ? "نشطة وتظهر للعملاء" : "معتمدة بانتظار الإعداد"}.`,
          en: `${app.businessName} approved.`,
        },
        `/washes/${biz.id}`,
      );
      return { application: await applicationById(t, app.id), businessId: biz.id };
    });
    return ok(result, `تمت الموافقة على ${result.application.businessName}`);
  }),

  route("POST", "/admin/applications/:id/reject", async ({ params, body, admin }) => {
    const app = await tx(async (t) => {
      const current = await applicationById(t, params.id);
      if (current.status === "approved" || current.status === "rejected") throw new MockApiError(DECIDED, 409);
      const reason = requireText(body.reason, "reason", "سبب الرفض", 5);
      const updated = await t`
        update public.wash_applications set status = 'rejected', review_note = ${reason}, reviewed_at = now()
        where id = ${current.id} and status in ('pending', 'needs_changes') returning id`;
      if (!updated.length) throw new MockApiError(DECIDED, 409);
      await logAudit(t, {
        actorId: admin.id,
        action: "reject_application",
        entity: "applications",
        entityId: current.id,
        oldValue: current.status,
        newValue: "rejected",
        reason,
      });
      return applicationById(t, current.id);
    });
    return ok(app, "تم رفض الطلب وإبلاغ المالك بالسبب");
  }),

  route("POST", "/admin/applications/:id/request-changes", async ({ params, body, admin }) => {
    const NOT_PENDING = "يمكن طلب التعديل على الطلبات قيد المراجعة فقط";
    const app = await tx(async (t) => {
      const current = await applicationById(t, params.id);
      if (current.status !== "pending") throw new MockApiError(NOT_PENDING, 409);
      const note = requireText(body.note, "note", "المطلوب تعديله", 5);
      const updated = await t`
        update public.wash_applications set status = 'needs_changes', review_note = ${note}, reviewed_at = now()
        where id = ${current.id} and status = 'pending' returning id`;
      if (!updated.length) throw new MockApiError(NOT_PENDING, 409);
      await logAudit(t, {
        actorId: admin.id,
        action: "request_changes_application",
        entity: "applications",
        entityId: current.id,
        oldValue: "pending",
        newValue: "needs_changes",
        reason: note,
      });
      return applicationById(t, current.id);
    });
    return ok(app, "تم إرسال طلب التعديل للمالك");
  }),
];
