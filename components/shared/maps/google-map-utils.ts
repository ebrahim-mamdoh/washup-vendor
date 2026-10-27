/** Types and helpers for the maps, free of @vis.gl so screens can import them without loading the map. */
export type LatLng = { lat: number; lng: number };
export type MapPoint = LatLng & { id: string; title: string; subtitle?: string };
export type PickedPlace = LatLng & { address: string; name: string };

export const CAIRO: LatLng = { lat: 30.0444, lng: 31.2357 };

export const googleMapsUrl = ({ lat, lng }: LatLng) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** A real coordinate (0,0 is how a missing location comes back from old rows). */
export const isSet = (p: LatLng | null | undefined): p is LatLng =>
  Boolean(p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0));
