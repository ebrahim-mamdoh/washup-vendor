import "server-only";

/*
 * Branch pin rules shared by the Super Admin (branch editor) and the partner portal ("join as a
 * wash"). Byte-identical in both repos (`npm run check:shared`, GAP-054).
 */

/** The pin every new wash got while the map had no API key. Reject it so branches are not stacked on one point. */
export const LEGACY_DEFAULT_PIN = { lat: 30.0131, lng: 31.4395 };

export function isLegacyDefaultPin(lat: number, lng: number): boolean {
  return Math.abs(lat - LEGACY_DEFAULT_PIN.lat) < 0.00005 && Math.abs(lng - LEGACY_DEFAULT_PIN.lng) < 0.00005;
}
