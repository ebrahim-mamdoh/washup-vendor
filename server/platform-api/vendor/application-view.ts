import "server-only";

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
