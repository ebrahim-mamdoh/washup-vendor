import "server-only";

import { MockApiError } from "../http";

/**
 * Public `GET /vendor/applications/:id` (GAP-005).
 *
 * - By application code (`app_…`): the code is the applicant's secret (kept in their browser and
 *   in the register link), so the full application is returned for status + "edit & resubmit".
 * - By phone number: anyone may type any number, so only the status is returned — no code, no
 *   contact data, no address/location/documents. The owner's name is reduced to a first name.
 */
type ApplicationLike = {
  status: string;
  businessName: string;
  ownerName: string;
  reviewNote?: string | null;
  submittedAt?: string | null;
};

export function phoneLookupView(app: ApplicationLike) {
  return {
    id: null,
    status: app.status,
    businessName: app.businessName,
    ownerName: String(app.ownerName ?? "").trim().split(/\s+/)[0] ?? "",
    submittedAt: app.submittedAt ?? null,
  };
}

/** Name the upload route gives every stored file (`app/api/v1/vendor/upload/route.ts`). */
const STORED_NAME = /^doc_\d{10,}_[0-9a-f]{8}\.(pdf|jpg|png|webp)$/;

/**
 * GAP-042: the application's documents must be files the upload route actually stored —
 * `application-documents/<name>` (commercial register, KYC) or `branch-photos/<name>`, or a bare
 * `<name>` from the local dev upload (no Supabase). A local filename (failed upload) is refused,
 * and at least one commercial-register document is required.
 */
export function cleanApplicationDocuments(raw: unknown): string[] {
  const list = Array.isArray(raw) ? [...new Set(raw.map(String).map((d) => d.trim()).filter(Boolean))] : [];
  const parts = list.map((d) => d.split("/"));
  const valid = (p: string[]) =>
    (p.length === 1 && STORED_NAME.test(p[0])) || (p.length === 2 && (p[0] === "application-documents" || p[0] === "branch-photos") && STORED_NAME.test(p[1]));
  if (parts.some((p) => !valid(p))) {
    throw new MockApiError("أحد المستندات لم يُرفع بنجاح — احذفه وأعد رفعه", 422, { documents: ["مستند غير مرفوع"] });
  }
  if (!parts.some((p) => p.length === 1 || p[0] === "application-documents")) {
    throw new MockApiError("ارفع السجل التجاري أو البطاقة الضريبية", 422, { documents: ["السجل التجاري مطلوب"] });
  }
  return list;
}
