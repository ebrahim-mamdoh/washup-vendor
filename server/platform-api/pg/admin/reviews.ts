import "server-only";

import type { Localized } from "@/types/common";
import type { HideReviewReason, Review, ReviewListItem } from "@/types/reviews";

import { round2 } from "../../db";
import { MockApiError, ok, requireText } from "../../http";
import { reviewsWhere } from "../entities";
import { orderBy, paged, searchPattern } from "../list";
import { branchNames, businessNames, customerNames } from "../lookups";
import { logAudit, pushVendorNotification } from "../platform";
import { route } from "../router";
import { type Q, db, tx } from "../sql";

const EMPTY: Localized = { ar: "—", en: "—" };

const HIDE_REASONS: Record<HideReviewReason, string> = {
  abusive_language: "ألفاظ مسيئة",
  spam: "محتوى دعائي (سبام)",
  off_topic: "خارج الموضوع",
  personal_data: "بيانات شخصية",
};

async function reviewById(q: Q, id: string): Promise<Review> {
  const [review] = await reviewsWhere(q, q`r.id = ${id}`);
  if (!review) throw new MockApiError("التقييم غير موجود", 404);
  return review;
}

/** Reviews (in page order) → list items with customer, wash, branch, service and order labels. */
async function toReviewListItems(q: Q, ids: string[]): Promise<ReviewListItem[]> {
  if (!ids.length) return [];
  const rows = await reviewsWhere(q, q`r.id = any(${ids})`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const reviews = ids.map((id) => byId.get(id)).filter((r): r is Review => Boolean(r));
  const serviceIds = [...new Set(reviews.map((r) => r.serviceId).filter(Boolean))];

  const [customers, businesses, branches, services, orders] = await Promise.all([
    customerNames(q, reviews.map((r) => r.customerId)),
    businessNames(q, reviews.map((r) => r.businessId)),
    branchNames(q, reviews.map((r) => r.branchId)),
    serviceIds.length
      ? q<{ id: string; name: Localized }[]>`select id, name from public.services where id = any(${serviceIds})`
      : Promise.resolve([]),
    q<{ id: string; number: string }[]>`select id, number from public.orders where id = any(${reviews.map((r) => r.orderId)})`,
  ]);
  const serviceLabels = new Map(services.map((s) => [s.id, s.name]));
  const numbers = new Map(orders.map((o) => [o.id, o.number]));
  return reviews.map((r) => ({
    ...r,
    customerName: customers.get(r.customerId) ?? "—",
    businessName: businesses.get(r.businessId) ?? EMPTY,
    branchName: branches.get(r.branchId) ?? EMPTY,
    serviceName: serviceLabels.get(r.serviceId) ?? EMPTY,
    orderNumber: numbers.get(r.orderId) ?? null,
  }));
}

export const reviewRoutes = [
  route("GET", "/admin/reviews", async ({ query }) => {
    const sql = db();
    const filter = query.get("filter") ?? "all";
    const search = searchPattern(query);

    const base = sql`
      select r.id, r.stars, r.reported_by_wash, r.status::text as status, r.created_at
      from public.reviews r
      left join public.customers cu on cu.id = r.customer_id
      left join public.businesses bz on bz.id = r.business_id
      left join public.orders o on o.id = r.order_id
      where true
        ${search ? sql`and (r.comment ->> 'ar' ilike ${search} or r.comment ->> 'en' ilike ${search} or coalesce(cu.name, '—') ilike ${search}
                         or coalesce(bz.name ->> 'ar', '—') ilike ${search} or o.number ilike ${search})` : sql``}`;

    const where =
      filter === "low"
        ? sql`where w.stars <= 2`
        : filter === "reported"
          ? sql`where w.reported_by_wash`
          : filter === "hidden"
            ? sql`where w.status = 'hidden'`
            : sql``;

    // The average covers every visible review (not just the search), computed with the mock's JS rounding.
    const [[counts], [{ total }], [visible]] = await Promise.all([
      sql<{ all: number; low: number; reported: number; hidden: number }[]>`
        with w as (${base})
        select count(*)::int as all,
               (count(*) filter (where w.stars <= 2))::int as low,
               (count(*) filter (where w.reported_by_wash))::int as reported,
               (count(*) filter (where w.status = 'hidden'))::int as hidden
        from w`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${where}`,
      sql<{ n: number; stars: number }[]>`
        select count(*)::int as n, coalesce(sum(stars), 0)::int as stars from public.reviews where status = 'visible'`,
    ]);
    const sort = orderBy(sql, query, { createdAt: "w.created_at", stars: "w.stars" }, { key: "createdAt", order: "desc" }, "w.id");
    const { items, pagination } = await paged(query, total, 12, async (limit, offset) => {
      const ids = await sql<{ id: string }[]>`with w as (${base}) select w.id from w ${where} ${sort} limit ${limit} offset ${offset}`;
      return toReviewListItems(sql, ids.map((r) => r.id));
    });
    return ok(items, "OK", {
      pagination,
      meta: { counts, averageRating: visible.n ? round2(visible.stars / visible.n) : 0 },
    });
  }),

  route("POST", "/admin/reviews/:id/visibility", async ({ params, body, admin }) => {
    // Keeping a reported review visible closes the wash's report (it leaves the "reported" queue).
    if (!body.hidden) {
      const kept = await tx(async (t) => {
        const current = await reviewById(t, params.id);
        if (current.status !== "visible" || !current.reportedByWash) return null;
        const reason = requireText(body.reason, "reason", "سبب الإبقاء");
        await t`update public.reviews set reported_by_wash = false, report_reason = null where id = ${current.id}`;
        await logAudit(t, {
          actorId: admin.id,
          action: "keep_review",
          entity: "reviews",
          entityId: current.id,
          branchId: current.branchId,
          oldValue: "reported",
          newValue: "visible",
          reason,
        });
        await pushVendorNotification(t, current.businessId, current.branchId, "review", "تمت مراجعة بلاغك على تقييم", "راجعت كارزن التقييم وقررت إبقاءه ظاهرًا.", "/reviews");
        return reviewById(t, current.id);
      });
      if (kept) return ok(kept, "تم إغلاق البلاغ وإبقاء التقييم ظاهرًا");
    }
    const { review, rating } = await tx(async (t) => {
      const current = await reviewById(t, params.id);
      const hidden = Boolean(body.hidden);
      if ((current.status === "hidden") === hidden) {
        throw new MockApiError(hidden ? "التقييم مخفي بالفعل" : "التقييم ظاهر بالفعل", 409);
      }
      let reason: string;
      let hiddenReason: HideReviewReason | null = null;
      if (hidden) {
        const key = String(body.reason ?? "") as HideReviewReason;
        if (!HIDE_REASONS[key]) throw new MockApiError("اختر سبب الإخفاء", 422);
        const note = typeof body.note === "string" ? body.note.trim() : "";
        reason = note ? `${HIDE_REASONS[key]} — ${note}` : HIDE_REASONS[key];
        hiddenReason = key;
      } else {
        reason = requireText(body.reason, "reason", "سبب الاستعادة");
      }
      const status = hidden ? "hidden" : "visible";

      // Status guard; the reviews trigger recomputes the branch and wash ratings
      // (same rule as the mock's recomputeRatings).
      const updated = await t`
        update public.reviews set status = ${status}, hidden_reason = ${hiddenReason}
        where id = ${current.id} and status = ${current.status} returning id`;
      if (!updated.length) throw new MockApiError(hidden ? "التقييم مخفي بالفعل" : "التقييم ظاهر بالفعل", 409);

      await logAudit(t, {
        actorId: admin.id,
        action: hidden ? "hide_review" : "restore_review",
        entity: "reviews",
        entityId: current.id,
        branchId: current.branchId,
        oldValue: current.status,
        newValue: status,
        reason,
      });
      const [biz] = await t<{ rating: number }[]>`select rating from public.businesses where id = ${current.businessId}`;
      const rating = biz?.rating ?? 0;
      await pushVendorNotification(
        t,
        current.businessId,
        current.branchId,
        "review",
        hidden ? "تم إخفاء تقييم بواسطة كارزن" : "تمت استعادة تقييم",
        `${hidden ? "تمت مراجعة التقييم وإخفاؤه" : "عاد التقييم للظهور"} — تقييم المغسلة الآن ${rating}.`,
        "/reviews",
      );
      return { review: await reviewById(t, current.id), rating };
    });
    return ok(review, `${review.status === "hidden" ? "تم إخفاء التقييم" : "تمت استعادة التقييم"} — تقييم المغسلة الآن ${rating}`);
  }),
];
