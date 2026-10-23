import "server-only";

import type { PgAdminContext, PgRouteDef } from "../router";
import { authRoutes } from "./auth";
import { washRoutes } from "./washes";
import { orderRoutes } from "./orders";
import { customerRoutes } from "./customers";
import { complaintRoutes } from "./complaints";
import { reviewRoutes } from "./reviews";
import { financeRoutes } from "./finance";
import { dashboardRoutes } from "./dashboard";
import { applicationRoutes } from "./applications";
import { offerRoutes } from "./offers";
import { adminRoutes } from "./admins";
import { platformRoutes } from "./platform";
import { pushRoutes } from "./push";

/** Admin namespace (`/api/v1/admin/*`) on Postgres — same route list as `../../index.ts`. */
export const ADMIN_ROUTES: PgRouteDef<PgAdminContext>[] = [...authRoutes, ...washRoutes, ...orderRoutes, ...customerRoutes, ...complaintRoutes, ...reviewRoutes, ...financeRoutes, ...dashboardRoutes, ...applicationRoutes, ...offerRoutes, ...adminRoutes, ...platformRoutes, ...pushRoutes];
