import "server-only";

import type { PgRouteDef, PgVendorContext } from "../router";
import { vendorApplicationRoutes } from "./applications";
import { vendorAuthRoutes } from "./auth";
import { vendorCatalogRoutes } from "./catalog";
import { vendorDashboardRoutes } from "./dashboard";
import { vendorInsightRoutes } from "./insights";
import { vendorOperationRoutes } from "./operations";
import { vendorPushRoutes } from "./push";
import { vendorTeamRoutes } from "./team";

/** Vendor namespace (`/api/v1/vendor/*`) on Postgres — same route list as `../../vendor/index.ts`. */
export const VENDOR_ROUTES: PgRouteDef<PgVendorContext>[] = [
  ...vendorApplicationRoutes,
  ...vendorAuthRoutes,
  ...vendorDashboardRoutes,
  ...vendorOperationRoutes,
  ...vendorInsightRoutes,
  ...vendorCatalogRoutes,
  ...vendorTeamRoutes,
  ...vendorPushRoutes,
];
