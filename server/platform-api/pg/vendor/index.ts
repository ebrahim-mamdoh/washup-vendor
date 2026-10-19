import "server-only";

import type { PgRouteDef, PgVendorContext } from "../router";
import { vendorAuthRoutes } from "./auth";
import { vendorDashboardRoutes } from "./dashboard";
import { vendorOperationRoutes } from "./operations";
import { vendorInsightRoutes } from "./insights";
import { vendorCatalogRoutes } from "./catalog";
import { vendorTeamRoutes } from "./team";

/** Vendor namespace (`/api/v1/vendor/*`) on Postgres — same route list as `../../vendor/index.ts`. */
export const VENDOR_ROUTES: PgRouteDef<PgVendorContext>[] = [...vendorAuthRoutes, ...vendorDashboardRoutes, ...vendorOperationRoutes, ...vendorInsightRoutes, ...vendorCatalogRoutes, ...vendorTeamRoutes];
