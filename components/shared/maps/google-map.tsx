"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTheme } from "next-themes";
import {
  APIProvider,
  AdvancedMarker,
  ColorScheme,
  InfoWindow,
  Map,
  Pin,
  useAdvancedMarkerRef,
  useMap,
  useMapsLibrary,
} from "@vis.gl/react-google-maps";
import { ExternalLink, MapPinOff } from "lucide-react";

import { cn } from "../../../lib/utils";
import { CAIRO, type LatLng, type MapPoint, type PickedPlace, googleMapsUrl, isSet, round6 } from "./google-map-utils";

/**
 * Google Maps for both panels (same file in the vendor portal and the Super Admin).
 * The Maps JavaScript API is loaded only when a map mounts; import these components
 * through next/dynamic so @vis.gl stays out of the page bundles.
 *
 * Env: NEXT_PUBLIC_GOOGLE_MAPS_API_KEY (browser key, restricted to the panels' domains;
 * needs Maps JavaScript API + Places API (New)), optional NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID
 * (a vector Map ID; Google's DEMO_MAP_ID otherwise).
 */
const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
const MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";


function BrandPin() {
  return <Pin background="#1463ff" borderColor="#0e4fd6" glyphColor="#ffffff" />;
}

/** Light/dark map matching the panel's theme (the scheme is fixed at creation, hence the key). */
function useColorScheme() {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === "dark" ? ColorScheme.DARK : ColorScheme.LIGHT;
}

function Unavailable({ className, point }: { className?: string; point?: LatLng | null }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-4 text-center text-xs text-muted-foreground", className)}>
      <MapPinOff className="size-5" />
      <span>الخريطة غير متاحة — مفتاح Google Maps غير مضبوط.</span>
      {isSet(point) ? (
        <a href={googleMapsUrl(point)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          <ExternalLink className="size-3.5" />
          فتح الموقع في خرائط Google
        </a>
      ) : null}
    </div>
  );
}

function Provider({ children }: { children: ReactNode }) {
  return (
    <APIProvider apiKey={API_KEY} language="ar" region="EG">
      {children}
    </APIProvider>
  );
}

/* ───────────────────────── Read-only map with pins ───────────────────────── */

function PointMarker({ point, open, onOpen }: { point: MapPoint; open: boolean; onOpen: (id: string | null) => void }) {
  const [ref, marker] = useAdvancedMarkerRef();
  return (
    <>
      <AdvancedMarker ref={ref} position={point} title={point.title} onClick={() => onOpen(open ? null : point.id)}>
        <BrandPin />
      </AdvancedMarker>
      {open ? (
        <InfoWindow anchor={marker} onCloseClick={() => onOpen(null)} headerDisabled>
          <div dir="rtl" className="min-w-40 space-y-1 p-1 font-sans text-[13px] text-[#0b1b33]">
            <p className="font-semibold">{point.title}</p>
            {point.subtitle ? <p className="text-xs text-[#64748b]">{point.subtitle}</p> : null}
            <a href={googleMapsUrl(point)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-[#1463ff] hover:underline">
              فتح في خرائط Google
            </a>
          </div>
        </InfoWindow>
      ) : null}
    </>
  );
}

/** Frames every pin once the map is ready (one pin: centred at street level). */
function FitPoints({ points }: { points: MapPoint[] }) {
  const map = useMap();
  const key = points.map((p) => `${p.lat},${p.lng}`).join("|");
  useEffect(() => {
    if (!map || points.length < 2) return;
    const bounds = new google.maps.LatLngBounds();
    for (const p of points) bounds.extend(p);
    map.fitBounds(bounds, 48);
    // `key` captures the points; the array identity changes on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, key]);
  return null;
}

/** A map showing one or more locations; clicking a pin opens its name and a Google Maps link. */
export function LocationsMap({ points, className, zoom = 15 }: { points: MapPoint[]; className?: string; zoom?: number }) {
  const scheme = useColorScheme();
  const [open, setOpen] = useState<string | null>(null);
  const valid = points.filter(isSet);
  if (!API_KEY) return <Unavailable className={className} point={valid[0]} />;
  if (!valid.length) return <Unavailable className={className} />;
  return (
    <div className={cn("overflow-hidden rounded-xl border border-border", className)}>
      <Provider>
        <Map
          key={scheme}
          mapId={MAP_ID}
          colorScheme={scheme}
          defaultCenter={valid[0]}
          defaultZoom={valid.length > 1 ? 11 : zoom}
          gestureHandling="cooperative"
          mapTypeControl={false}
          streetViewControl={false}
          className="size-full"
        >
          {valid.map((p) => (
            <PointMarker key={p.id} point={p} open={open === p.id} onOpen={setOpen} />
          ))}
          <FitPoints points={valid} />
        </Map>
      </Provider>
    </div>
  );
}

/* ───────────────────────── Location picker ───────────────────────── */

/** Places (New) autocomplete, limited to Egypt; picking a result moves the pin there. */
function PlaceSearch({ onPick, placeholder }: { onPick: (p: PickedPlace) => void; placeholder: string }) {
  const places = useMapsLibrary("places");
  const host = useRef<HTMLDivElement>(null);
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const el = host.current;
    if (!places || !el) return;
    const input = new places.PlaceAutocompleteElement({ includedRegionCodes: ["eg"], placeholder });
    input.style.width = "100%";
    input.style.colorScheme = resolvedTheme === "dark" ? "dark" : "light";
    const onSelect = async (event: Event) => {
      const prediction = (event as google.maps.places.PlacePredictionSelectEvent).placePrediction;
      if (!prediction) return;
      const place = prediction.toPlace();
      await place.fetchFields({ fields: ["location", "formattedAddress", "displayName"] });
      if (!place.location) return;
      pick.current({
        lat: round6(place.location.lat()),
        lng: round6(place.location.lng()),
        address: place.formattedAddress ?? "",
        name: place.displayName ?? "",
      });
    };
    input.addEventListener("gmp-select", onSelect);
    el.replaceChildren(input);
    return () => {
      input.removeEventListener("gmp-select", onSelect);
      input.remove();
    };
  }, [places, placeholder, resolvedTheme]);

  return <div ref={host} className="min-h-10" />;
}

/** Pans to the pin when it moves from outside the map (search result, GPS, area change). */
function FollowValue({ value, fromMap }: { value: LatLng | null; fromMap: RefObject<string> }) {
  const map = useMap();
  useEffect(() => {
    if (!map || !value) return;
    const k = `${value.lat},${value.lng}`;
    if (fromMap.current === k) return;
    map.panTo(value);
    if ((map.getZoom() ?? 0) < 15) map.setZoom(16);
  }, [map, value, fromMap]);
  return null;
}

function loadOnce(tag: "script" | "link", attr: string, value: string) {
  return new Promise<void>((resolve, reject) => {
    const selector = tag === "script" ? `script[src="${value}"]` : `link[href="${value}"]`;
    if (document.querySelector(selector)) {
      resolve();
      return;
    }
    const el = document.createElement(tag);
    el.setAttribute(attr, value);
    if (tag === "link") el.setAttribute("rel", "stylesheet");
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(value));
    document.head.appendChild(el);
  });
}

/** Click-and-drag pin on OpenStreetMap when the Google Maps key is not configured. */
function OsmLocationPicker({ value, onChange, fallbackCenter, className }: Pick<LocationPickerProps, "value" | "onChange" | "fallbackCenter" | "className">) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let map: any = null;
    let cancelled = false;
    (async () => {
      await loadOnce("link", "href", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css");
      await loadOnce("script", "src", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js");
      const L = (window as unknown as { L?: any }).L;
      if (cancelled || !L || !host.current) return;
      const center = value ?? fallbackCenter ?? CAIRO;
      map = L.map(host.current, { zoomControl: true }).setView([center.lat, center.lng], value ? 16 : 12);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap" }).addTo(map);
      const icon = L.divIcon({
        className: "",
        html: '<div style="width:18px;height:18px;border-radius:99px;background:#1463ff;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35)"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      });
      const marker = value ? L.marker([value.lat, value.lng], { icon, draggable: true }).addTo(map) : null;
      const place = (lat: number, lng: number, existing: { setLatLng: (p: [number, number]) => void } | null) => {
        const p = { lat: round6(lat), lng: round6(lng) };
        if (existing) existing.setLatLng([p.lat, p.lng]);
        onChangeRef.current(p);
      };
      marker?.on("dragend", () => {
        const p = marker.getLatLng();
        place(p.lat, p.lng, marker);
      });
      map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
        if (!marker) {
          const created = L.marker([e.latlng.lat, e.latlng.lng], { icon, draggable: true }).addTo(map);
          created.on("dragend", () => {
            const p = created.getLatLng();
            place(p.lat, p.lng, created);
          });
        } else {
          marker.setLatLng(e.latlng);
        }
        place(e.latlng.lat, e.latlng.lng, marker);
      });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      map?.remove();
    };
    // Mount once; later picks come from the map itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-2">
      <div ref={host} className={cn("h-[280px] w-full overflow-hidden rounded-xl border border-border", className)} />
      <p className="text-[11px] text-muted-foreground">الخريطة عبر OpenStreetMap. انقر لتحديد الدبوس أو اسحبه. لخرائط Google اضبط مفتاح الخرائط.</p>
    </div>
  );
}

type LocationPickerProps = {
  value: LatLng | null;
  onChange: (p: LatLng) => void;
  /** Called with the address and name when the location comes from the search box. */
  onPlace?: (p: PickedPlace) => void;
  /** Where the map opens when there is no value yet. */
  fallbackCenter?: LatLng;
  searchPlaceholder?: string;
  className?: string;
};

/** Search an address, click the map or drag the pin. Coordinates are rounded to 6 decimals (~10 cm). */
export function LocationPicker({ value, onChange, onPlace, fallbackCenter = CAIRO, searchPlaceholder = "ابحث عن العنوان أو اسم المكان", className }: LocationPickerProps) {
  const scheme = useColorScheme();
  // The last position the map itself produced: FollowValue doesn't pan back to it.
  const fromMap = useRef("");
  const point = isSet(value) ? value : null;

  if (!API_KEY) {
    // Remount when the empty map should jump to a new country or area. A placed
    // pin keeps a stable key so dragging does not rebuild the map.
    const viewKey = point ? "pin" : `${fallbackCenter.lat},${fallbackCenter.lng}`;
    return (
      <OsmLocationPicker
        key={viewKey}
        value={point}
        onChange={onChange}
        fallbackCenter={fallbackCenter}
        className={className}
      />
    );
  }

  const set = (lat: number, lng: number) => {
    const p = { lat: round6(lat), lng: round6(lng) };
    fromMap.current = `${p.lat},${p.lng}`;
    onChange(p);
  };

  return (
    <Provider>
      <div className="space-y-2">
        <PlaceSearch
          placeholder={searchPlaceholder}
          onPick={(p) => {
            onChange({ lat: p.lat, lng: p.lng });
            onPlace?.(p);
          }}
        />
        <div className={cn("overflow-hidden rounded-xl border border-border", className)}>
          <Map
            key={point ? scheme : `${scheme}:${fallbackCenter.lat},${fallbackCenter.lng}`}
            mapId={MAP_ID}
            colorScheme={scheme}
            defaultCenter={point ?? fallbackCenter}
            defaultZoom={point ? 16 : 12}
            gestureHandling="cooperative"
            clickableIcons={false}
            mapTypeControl={false}
            streetViewControl={false}
            onClick={(e) => e.detail.latLng && set(e.detail.latLng.lat, e.detail.latLng.lng)}
            className="size-full"
          >
            {point ? (
              <AdvancedMarker
                position={point}
                draggable
                title="اسحب لتعديل الموقع"
                onDragEnd={(e) => e.latLng && set(e.latLng.lat(), e.latLng.lng())}
              >
                <BrandPin />
              </AdvancedMarker>
            ) : null}
            <FollowValue value={point} fromMap={fromMap} />
          </Map>
        </div>
      </div>
    </Provider>
  );
}
