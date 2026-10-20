/**
 * Runs once per server instance. The API's "today", day closings, schedules and
 * reports use the server's local time, so pin it to the business time zone
 * (Cairo) instead of whatever the host uses (UTC on most cloud hosts).
 * Override with TZ in the environment.
 */
export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && !process.env.TZ) {
    process.env.TZ = "Africa/Cairo";
  }
}
