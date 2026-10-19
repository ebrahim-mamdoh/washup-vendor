import "server-only";

import type { Offer, OfferListItem, OfferStatus } from "@/types/offers";

import { now } from "../../db";
import { MockApiError, ok, requireText } from "../../http";
import { OFFER_COLS, offersWhere } from "../entities";
import { countsOf, orderBy, paged, searchPattern } from "../list";
import { logAudit } from "../platform";
import { route } from "../router";
import { type Q, db, tx } from "../sql";

const STATUSES: OfferStatus[] = ["draft", "scheduled", "active", "expired", "disabled"];

/** Status is derived from dates unless the offer is a draft or manually disabled (same rule as the mock). */
function deriveStatus(offer: Pick<Offer, "status" | "startAt" | "endAt">): OfferStatus {
  if (offer.status === "draft" || offer.status === "disabled") return offer.status;
  const t = now().getTime();
  if (new Date(offer.endAt).getTime() < t) return "expired";
  if (new Date(offer.startAt).getTime() > t) return "scheduled";
  return "active";
}

/** SQL for `deriveStatus` over the offer alias `of`, against the demo clock. */
const DERIVED_STATUS = (q: Q, at: string) => q`
  case when of.status in ('draft', 'disabled') then of.status::text
       when of.ends_at < ${at} then 'expired'
       when of.starts_at > ${at} then 'scheduled'
       else 'active' end`;

function parsePayload(body: Record<string, unknown>) {
  const title = (body.title ?? {}) as { ar?: string; en?: string };
  const description = (body.description ?? {}) as { ar?: string; en?: string };
  const titleAr = requireText(title.ar, "title.ar", "العنوان بالعربية");
  const titleEn = requireText(title.en, "title.en", "العنوان بالإنجليزية");
  const discountType = body.discountType === "fixed" ? "fixed" : "percent";
  const discountValue = Number(body.discountValue);
  if (Number.isNaN(discountValue) || discountValue <= 0) throw new MockApiError("قيمة الخصم غير صالحة", 422);
  if (discountType === "percent" && discountValue > 50) throw new MockApiError("الحد الأقصى للخصم ٥٠٪", 422);
  const startAt = new Date(String(body.startAt));
  const endAt = new Date(String(body.endAt));
  if (Number.isNaN(+startAt) || Number.isNaN(+endAt) || endAt <= startAt) {
    throw new MockApiError("تاريخ النهاية يجب أن يكون بعد تاريخ البداية", 422);
  }
  const branchIds = Array.isArray(body.branchIds) ? body.branchIds.map(String) : [];
  if (!branchIds.length) throw new MockApiError("اختر فرعًا واحدًا على الأقل", 422);
  return {
    title: { ar: titleAr, en: titleEn },
    description: { ar: String(description.ar ?? "").trim(), en: String(description.en ?? "").trim() },
    discountType: discountType as Offer["discountType"],
    discountValue,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    branchIds: [...new Set(branchIds)],
    serviceCategories: [...new Set(Array.isArray(body.serviceCategories) ? body.serviceCategories.map(String) : [])],
  };
}

async function offerById(q: Q, id: string): Promise<Offer> {
  const [offer] = await offersWhere(q, q`of.id = ${id}`);
  if (!offer) throw new MockApiError("العرض غير موجود", 404);
  return offer;
}

/** Replaces the offer's branch and category links. */
async function setLinks(t: Q, offerId: string, branchIds: string[], categories: string[]) {
  await t`delete from public.offer_branches where offer_id = ${offerId}`;
  await t`delete from public.offer_categories where offer_id = ${offerId}`;
  await t`insert into public.offer_branches (offer_id, branch_id) select ${offerId}, b from unnest(${branchIds}::text[]) as b`;
  if (categories.length) {
    await t`insert into public.offer_categories (offer_id, category_id) select ${offerId}, c from unnest(${categories}::text[]) as c`;
  }
}

export const offerRoutes = [
  route("GET", "/admin/offers", async ({ query }) => {
    const sql = db();
    const status = query.get("status");
    const scope = query.get("scope");
    const search = searchPattern(query);
    const at = now().toISOString();

    const base = sql`
      select ${sql.unsafe(OFFER_COLS)}, ${DERIVED_STATUS(sql, at)} as "derivedStatus",
             (select bz.name from public.businesses bz where bz.id = of.business_id) as "businessName",
             (select count(*)::int from public.offer_branches ob where ob.offer_id = of.id) as "branchesCount",
             (select count(*)::int from public.orders o where o.offer_id = of.id)
               + case when of.id = 'of_platform' then 64 when of.status = 'active' then 18 else 0 end as redemptions
      from public.offers of
      where true
        ${scope && scope !== "all" ? sql`and of.scope::text = ${scope}` : sql``}
        ${search ? sql`and (of.title ->> 'ar' ilike ${search} or of.title ->> 'en' ilike ${search})` : sql``}`;
    const filter = status && status !== "all" ? sql`where w."derivedStatus" = ${status}` : sql``;

    const [countRows, [{ total }]] = await Promise.all([
      sql<{ k: string; n: number }[]>`with w as (${base}) select w."derivedStatus" as k, count(*)::int as n from w group by w."derivedStatus"`,
      sql<{ total: number }[]>`with w as (${base}) select count(*)::int as total from w ${filter}`,
    ]);
    const sort = orderBy(sql, query, { startAt: `w."startAt"`, endAt: `w."endAt"` }, { key: "startAt", order: "desc" }, "w.id");
    const { items, pagination } = await paged(query, total, 12, (limit, offset) =>
      sql<(OfferListItem & { derivedStatus: OfferStatus })[]>`with w as (${base}) select * from w ${filter} ${sort} limit ${limit} offset ${offset}`,
    );
    const list: OfferListItem[] = items.map(({ derivedStatus, ...o }) => ({ ...o, status: derivedStatus }));
    return ok(list, "OK", { pagination, meta: { counts: countsOf(countRows, STATUSES) } });
  }),

  route("POST", "/admin/offers", async ({ body, admin }) => {
    const data = parsePayload(body);
    const status = deriveStatus({ status: body.publish ? "active" : "draft", startAt: data.startAt, endAt: data.endAt });
    const offer = await tx(async (t) => {
      const [row] = await t<{ id: string }[]>`
        insert into public.offers (scope, business_id, title, description, discount_type, discount_value, starts_at, ends_at, status, featured)
        values ('platform', null, ${t.json(data.title)}, ${t.json(data.description)}, ${data.discountType}, ${data.discountValue},
                ${data.startAt}, ${data.endAt}, ${status}, false)
        returning id`;
      await setLinks(t, row.id, data.branchIds, data.serviceCategories);
      await logAudit(t, {
        actorId: admin.id,
        action: "create_offer",
        entity: "offers",
        entityId: row.id,
        newValue: { title: data.title.ar, status },
        reason: null,
      });
      return offerById(t, row.id);
    });
    return ok(offer, offer.status === "draft" ? "تم حفظ العرض كمسودة" : "تم نشر العرض");
  }),

  route("PATCH", "/admin/offers/:id", async ({ params, body, admin }) => {
    const offer = await tx(async (t) => {
      const current = await offerById(t, params.id);
      if (current.scope !== "platform") throw new MockApiError("عروض المغاسل تُدار من لوحة المغسلة", 403);
      const data = parsePayload(body);
      const stored = body.publish && current.status === "draft" ? "active" : current.status;
      const status = deriveStatus({ status: stored, startAt: data.startAt, endAt: data.endAt });
      await t`
        update public.offers
        set title = ${t.json(data.title)}, description = ${t.json(data.description)}, discount_type = ${data.discountType},
            discount_value = ${data.discountValue}, starts_at = ${data.startAt}, ends_at = ${data.endAt}, status = ${status}
        where id = ${current.id}`;
      await setLinks(t, current.id, data.branchIds, data.serviceCategories);
      await logAudit(t, {
        actorId: admin.id,
        action: "update_offer",
        entity: "offers",
        entityId: current.id,
        oldValue: { title: current.title.ar, discount: current.discountValue },
        newValue: { title: data.title.ar, discount: data.discountValue },
      });
      return offerById(t, current.id);
    });
    return ok(offer, "تم تحديث العرض");
  }),

  route("POST", "/admin/offers/:id/status", async ({ params, body, admin }) => {
    const enable = Boolean(body.enabled);
    const offer = await tx(async (t) => {
      const current = await offerById(t, params.id);
      const old = deriveStatus(current);
      const status = deriveStatus({ ...current, status: enable ? "active" : "disabled" });
      await t`update public.offers set status = ${status} where id = ${current.id}`;
      await logAudit(t, {
        actorId: admin.id,
        action: enable ? "enable_offer" : "disable_offer",
        entity: "offers",
        entityId: current.id,
        oldValue: old,
        newValue: status,
        reason: typeof body.reason === "string" ? body.reason : null,
      });
      return { ...current, status };
    });
    return ok(offer, enable ? "تم تفعيل العرض" : "تم إيقاف العرض");
  }),
];
