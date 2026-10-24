import "server-only";

import type { SubmitApplicationPayload, WashApplication } from "@/types/applications";
import { nid, now, pushAdminNotification } from "../db";
import { MockApiError, ok, requireText } from "../http";
import { vroute } from "../router";
import { normalizePhone } from "./engine";

export const vendorApplicationRoutes = [
  vroute(
    "POST",
    "/vendor/applications",
    ({ db, body }) => {
      const data = body as unknown as SubmitApplicationPayload;
      const businessName = requireText(data.businessName, "businessName", "اسم المغسلة", 2);
      const ownerName = requireText(data.ownerName, "ownerName", "اسم المالك", 2);
      const phone = normalizePhone(String(data.phone ?? ""));
      if (phone.length !== 10) {
        throw new MockApiError("رقم موبايل مصري غير صحيح (11 رقم يبدأ بـ 01)", 422, { phone: ["رقم غير صحيح"] });
      }
      const email = String(data.email ?? "").trim();
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

      const id = `app_${nid("app")}`;
      const submittedAt = now().toISOString();

      const app: WashApplication = {
        id,
        businessName,
        ownerName,
        phone: `+20 ${phone.slice(0, 3)} ${phone.slice(3, 6)} ${phone.slice(6)}`,
        email,
        area,
        address,
        lat,
        lng,
        capacity,
        workingHours,
        services,
        documents,
        status: "pending",
        reviewNote: null,
        submittedAt,
        reviewedAt: null,
        businessId: null,
      };

      db.applications.unshift(app);

      // Trigger admin notification so Super Admin sees it immediately
      pushAdminNotification(
        db,
        "application",
        { ar: "طلب انضمام جديد", en: "New wash application" },
        {
          ar: `قدمت مغسلة ${businessName} (${ownerName}) طلب انضمام جديد.`,
          en: `Wash ${businessName} submitted an application.`,
        },
        `/applications/${id}`,
      );

      return ok(app, "تم تقديم طلب الانضمام بنجاح وسيتواصل معك فريق كارزن قريبًا");
    },
    true, // isPublic = true
  ),

  vroute(
    "GET",
    "/vendor/applications/:id",
    ({ db, params }) => {
      const app = db.applications.find((a) => a.id === params.id);
      if (!app) throw new MockApiError("طلب الانضمام غير موجود", 404);
      return ok(app);
    },
    true, // isPublic = true
  ),
];
