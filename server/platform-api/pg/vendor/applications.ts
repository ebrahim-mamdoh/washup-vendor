import "server-only";

import type { SubmitApplicationPayload, WashApplication } from "@/types/applications";
import type postgres from "postgres";
import { MockApiError, ok, requireText } from "../../http";
import { applicationsWhere } from "../entities";
import { isValidPhone, toE164 } from "../phone";
import { pushAdminNotification } from "../platform";
import { vroute } from "../router";
import { db } from "../sql";

export const vendorApplicationRoutes = [
  vroute(
    "POST",
    "/vendor/applications",
    async ({ body }) => {
      const data = body as unknown as SubmitApplicationPayload;
      const businessName = requireText(data.businessName, "businessName", "اسم المغسلة", 2);
      const ownerName = requireText(data.ownerName, "ownerName", "اسم المالك", 2);
      const phoneE164 = toE164(String(data.phone ?? ""));
      if (!isValidPhone(phoneE164)) {
        throw new MockApiError("رقم موبايل غير صحيح", 422, { phone: ["رقم غير صحيح"] });
      }

      // Prevent duplicate pending applications for the same phone (W16)
      const sqlCheck = db();
      const [existingPending] = await sqlCheck`
        select id from public.wash_applications
        where phone = ${phoneE164} and status = 'pending' limit 1`;
      if (existingPending) {
        throw new MockApiError("يوجد طلب انضمام قيد المراجعة مسجل بهذا الهاتف بالفعل", 409, {
          phone: ["يوجد طلب قيد المراجعة بهذا الهاتف"],
        });
      }
      const rawEmail = String(data.email ?? "").trim();
      const email = rawEmail.includes("@") ? rawEmail : `${phoneE164.replace(/\D/g, "")}@partner.washup.app`;
      const area = String(data.area ?? "nasr").trim();
      const address = requireText(data.address, "address", "عنوان المغسلة", 5);
      const lat = Number(data.lat) || 30.05;
      const lng = Number(data.lng) || 31.33;
      const capacity = Math.max(1, Math.min(20, Number(data.capacity) || 4));

      const services = Array.isArray(data.services) && data.services.length
        ? data.services.map((s) => ({
            name: String(s.name || "غسيل خارجي"),
            price: Math.max(0, Number(s.price) || 100),
            durationMin: Math.max(5, Number(s.durationMin) || 20),
          }))
        : [
            { name: "غسيل خارجي", price: 100, durationMin: 20 },
            { name: "غسيل داخلي", price: 100, durationMin: 25 },
            { name: "غسيل داخلي وخارجي", price: 180, durationMin: 40 },
          ];

      const workingHours = Array.isArray(data.workingHours) && data.workingHours.length
        ? data.workingHours
        : Array.from({ length: 7 }, () => ({ open: "09:00", close: "23:00", closed: false }));

      const documents = Array.isArray(data.documents) && data.documents.length
        ? data.documents.map(String)
        : ["commercial_reg.pdf"];

      const sql = db();
      const id = `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

      await sql`
        insert into public.wash_applications (
          id, business_name, owner_name, phone, email, area_id, address, lat, lng,
          capacity, services, working_hours, documents, status, submitted_at
        ) values (
          ${id}, ${businessName}, ${ownerName}, ${phoneE164}, ${email}, ${area}, ${address}, ${lat}, ${lng},
          ${capacity}, ${sql.json(services as unknown as postgres.JSONValue)}, ${sql.json(workingHours as unknown as postgres.JSONValue)}, ${documents}, 'pending', now()
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
      return ok(app, "تم تقديم طلب الانضمام بنجاح وسيتواصل معك فريق كارزن قريبًا");
    },
    true,
  ),

  vroute(
    "GET",
    "/vendor/applications/:id",
    async ({ params }) => {
      const sql = db();
      const target = String(params.id ?? "").trim();
      let app: WashApplication | undefined;

      if (target.startsWith("app_")) {
        [app] = await applicationsWhere(sql, sql`ap.id = ${target}`);
      } else {
        const phoneE = toE164(target);
        if (isValidPhone(phoneE)) {
          [app] = await applicationsWhere(
            sql,
            sql`ap.phone = ${phoneE}`,
            sql`order by ap.submitted_at desc limit 1`
          );
        }
      }

      if (!app) throw new MockApiError("طلب الانضمام غير موجود", 404);
      // Respond with status only to protect sensitive owner data (W16)
      return ok({
        id: app.id,
        businessName: app.businessName,
        status: app.status,
        reviewNote: app.status === "needs_changes" || app.status === "rejected" ? app.reviewNote : null,
        submittedAt: app.submittedAt,
        reviewedAt: app.reviewedAt,
      });
    },
    true,
  ),
];
