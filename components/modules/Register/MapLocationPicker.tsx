"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  LocateFixed,
  Lock,
  MapPin,
  Navigation,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

// Import Leaflet CSS
import "leaflet/dist/leaflet.css";

const AREA_COORDINATES: Record<string, [number, number]> = {
  nasr: [30.0561, 31.3412],
  helio: [30.112, 31.345],
  nc: [30.0131, 31.4395],
  maadi: [29.9602, 31.2569],
  zamalek: [30.0631, 31.2185],
  moh: [30.0524, 31.2003],
  zayed: [30.045, 30.985],
  oct: [29.972, 30.94],
};

interface MapLocationPickerProps {
  lat: number;
  lng: number;
  area?: string;
  onChange: (lat: number, lng: number) => void;
}

export default function MapLocationPicker({
  lat,
  lng,
  area = "nc",
  onChange,
}: MapLocationPickerProps) {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const [locating, setLocating] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);

  // Initialize Leaflet Map
  useEffect(() => {
    let isMounted = true;

    async function initMap() {
      if (!mapContainerRef.current || mapInstanceRef.current) return;

      const L = (await import("leaflet")).default;

      if (!isMounted || !mapContainerRef.current) return;

      const initialLat = lat || AREA_COORDINATES[area]?.[0] || 30.0131;
      const initialLng = lng || AREA_COORDINATES[area]?.[1] || 31.4395;

      const map = L.map(mapContainerRef.current, {
        center: [initialLat, initialLng],
        zoom: 14,
        zoomControl: true,
      });

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      // Custom crisp SVG Pin matching Carzen primary theme
      const customPin = L.divIcon({
        className: "carzen-map-marker",
        html: `
          <div style="
            position: relative;
            width: 36px;
            height: 36px;
            background: #0284c7;
            border: 2.5px solid #ffffff;
            border-radius: 50% 50% 50% 0;
            transform: rotate(-45deg);
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(2, 132, 199, 0.45);
          ">
            <div style="
              width: 12px;
              height: 12px;
              background: #ffffff;
              border-radius: 50%;
            "></div>
          </div>
        `,
        iconSize: [36, 36],
        iconAnchor: [18, 36],
      });

      const marker = L.marker([initialLat, initialLng], {
        icon: customPin,
        draggable: true,
      }).addTo(map);

      // Handle Map Click
      map.on("click", (e: any) => {
        const { lat: newLat, lng: newLng } = e.latlng;
        marker.setLatLng([newLat, newLng]);
        onChange(Number(newLat.toFixed(6)), Number(newLng.toFixed(6)));
      });

      // Handle Marker Drag
      marker.on("dragend", (e: any) => {
        const pos = e.target.getLatLng();
        onChange(Number(pos.lat.toFixed(6)), Number(pos.lng.toFixed(6)));
      });

      mapInstanceRef.current = map;
      markerRef.current = marker;
      setMapReady(true);

      // Invalidate size after layout settles
      setTimeout(() => {
        map.invalidateSize();
      }, 250);
    }

    initMap();

    return () => {
      isMounted = false;
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
        markerRef.current = null;
      }
    };
  }, []);

  // Update marker position when lat/lng change from outside (e.g. area change)
  useEffect(() => {
    if (mapReady && markerRef.current && mapInstanceRef.current) {
      const currentPos = markerRef.current.getLatLng();
      if (
        Math.abs(currentPos.lat - lat) > 0.0001 ||
        Math.abs(currentPos.lng - lng) > 0.0001
      ) {
        markerRef.current.setLatLng([lat, lng]);
        mapInstanceRef.current.setView([lat, lng], mapInstanceRef.current.getZoom(), {
          animate: true,
        });
      }
    }
  }, [lat, lng, mapReady]);

  // Real-time listener for browser permission changes
  useEffect(() => {
    if (typeof window === "undefined" || !navigator.permissions?.query) return;

    let isMounted = true;
    navigator.permissions
      .query({ name: "geolocation" as PermissionName })
      .then((status) => {
        if (!isMounted) return;
        status.onchange = () => {
          if (status.state === "granted") {
            setShowPermissionDialog(false);
            toast.success("تم تفعيل صلاحية الموقع بنجاح! جاري التحديد الآن...");
            executeGetPosition(true);
          }
        };
      })
      .catch(() => {});

    return () => {
      isMounted = false;
    };
  }, []);

  // Execute geolocation with smart fallback (GPS first, then Wi-Fi/Network)
  const executeGetPosition = (highAccuracy: boolean) => {
    setLocating(true);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const userLat = Number(pos.coords.latitude.toFixed(6));
        const userLng = Number(pos.coords.longitude.toFixed(6));

        onChange(userLat, userLng);

        if (mapInstanceRef.current && markerRef.current) {
          markerRef.current.setLatLng([userLat, userLng]);
          mapInstanceRef.current.setView([userLat, userLng], 16, { animate: true });
        }

        toast.success("تم تحديد موقعك بدقة على الخريطة 📍");
        setLocating(false);
        setShowPermissionDialog(false);
      },
      (err) => {
        console.warn("[Geolocation Error]", err);
        // If high accuracy times out or fails (e.g. PC without dedicated GPS chip), fallback to network triangulation
        if (highAccuracy && (err.code === 2 || err.code === 3)) {
          executeGetPosition(false);
          return;
        }

        setLocating(false);
        if (err.code === 1) {
          // Permission Denied
          setShowPermissionDialog(true);
        } else if (err.code === 2) {
          toast.error("خدمة الموقع الجغرافي غير مفعلة على جهازك حالياً. يمكنك النقر على الخريطة لتحديد الموقع.");
        } else if (err.code === 3) {
          toast.error("استغرقت عملية تحديد الموقع وقتاً طويلاً. يرجى سحب المؤشر أو النقر على موقع المغسلة مباشرة.");
        } else {
          toast.error("تعذر تحديد موقعك الحالي. يرجى اختيار موقعك على الخريطة.");
        }
      },
      {
        enableHighAccuracy: highAccuracy,
        timeout: highAccuracy ? 6000 : 10000,
        maximumAge: 60000,
      }
    );
  };

  // Quick Button for Current Location
  const handleLocateMe = async () => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      toast.error("متصفحك لا يدعم تحديد الموقع الجغرافي");
      return;
    }

    // Check if permission was already explicitly blocked
    if (navigator.permissions?.query) {
      try {
        const status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
        if (status.state === "denied") {
          setShowPermissionDialog(true);
          return;
        }
      } catch {
        // Fallback to native getCurrentPosition if query fails
      }
    }

    toast.info("جاري البحث عن موقعك الحالي عبر المتصفح...");
    executeGetPosition(true);
  };

  return (
    <div className="space-y-3">
      {/* Top Map Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <MapPin className="size-3.5 text-primary" />
          <span>انقر على الخريطة أو اسحب المؤشر لتحديد موقع المغسلة بدقة:</span>
        </div>

        {/* Quick Button for Current Location */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleLocateMe}
          disabled={locating}
          className="border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary active:scale-95 transition-all cursor-pointer"
        >
          {locating ? (
            <RefreshCw className="me-1.5 size-3.5 animate-spin" />
          ) : (
            <LocateFixed className="me-1.5 size-3.5 text-primary" />
          )}
          {locating ? "جاري التحديد..." : "تحديد موقعي الحالي (GPS)"}
        </Button>
      </div>

      {/* Map Container */}
      <div className="relative overflow-hidden rounded-xl border border-border shadow-inner bg-muted/40">
        <div
          ref={mapContainerRef}
          className="h-[280px] w-full z-0 sm:h-[320px]"
          style={{ minHeight: "260px" }}
        />

        {/* Subtle Map Overlay Badge */}
        <div className="pointer-events-none absolute bottom-3 end-3 z-10 rounded-lg bg-background/90 px-3 py-1.5 text-[11px] font-mono shadow-sm backdrop-blur border border-border/80">
          <span className="text-muted-foreground">Lat:</span> <span className="font-semibold text-primary">{lat}</span> |{" "}
          <span className="text-muted-foreground">Lng:</span> <span className="font-semibold text-primary">{lng}</span>
        </div>
      </div>

      {/* Geolocation Permission Helper Dialog */}
      <Dialog open={showPermissionDialog} onOpenChange={setShowPermissionDialog}>
        <DialogContent className="sm:max-w-md gap-0 p-0 overflow-hidden" showCloseButton={true}>
          {/* Header */}
          <div className="bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-6 text-center border-b">
            <div className="mx-auto mb-3 flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary shadow-xs">
              <ShieldAlert className="size-7" />
            </div>
            <DialogTitle className="text-lg font-bold">
              السماح بالوصول إلى الموقع الجغرافي 📍
            </DialogTitle>
            <DialogDescription className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              يحتاج المتصفح لإذن الوصول لتحديد موقع مغسلتك بدقة دون الحاجة للبحث في إعدادات النظام.
            </DialogDescription>
          </div>

          {/* Quick Steps Guide */}
          <div className="p-6 space-y-3.5 text-right">
            <p className="text-xs font-semibold text-muted-foreground">
              خطوات تفعيل الصلاحية بثانية واحدة من المتصفح:
            </p>

            <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary font-bold text-xs">
                1
              </div>
              <div className="space-y-0.5 text-xs">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  انقر على أيقونة الإعدادات أو القفل <Lock className="size-3.5 text-primary inline" />
                </span>
                <p className="text-muted-foreground leading-relaxed">
                  تجدها في أعلى نافذة المتصفح بجانب رابط الموقع (URL).
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary font-bold text-xs">
                2
              </div>
              <div className="space-y-0.5 text-xs">
                <span className="font-semibold text-foreground flex items-center gap-1.5">
                  فعّل خيار «الموقع» (Location)
                </span>
                <p className="text-muted-foreground leading-relaxed">
                  غيّر الصلاحية إلى <span className="font-bold text-primary">«سماح» (Allow)</span> أو قم بتشغيل المفتاح.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 font-bold text-xs">
                3
              </div>
              <div className="space-y-0.5 text-xs">
                <span className="font-semibold text-foreground">
                  اضغط «إعادة المحاولة» أو حرّك المؤشر
                </span>
                <p className="text-muted-foreground leading-relaxed">
                  ستلتقط الصفحة موقعك الحالي فوراً وتضعه على الخريطة.
                </p>
              </div>
            </div>
          </div>

          {/* Footer Actions */}
          <DialogFooter className="p-4 bg-muted/20 border-t flex flex-col-reverse sm:flex-row gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowPermissionDialog(false);
                toast.info("يمكنك النقر مباشرة على أي نقطة بالخريطة لتحديد موقع المغسلة");
              }}
              className="w-full sm:w-auto text-xs"
            >
              تحديد الموقع يدوياً على الخريطة
            </Button>
            <Button
              type="button"
              onClick={() => {
                setShowPermissionDialog(false);
                handleLocateMe();
              }}
              className="w-full sm:w-auto text-xs gap-1.5"
            >
              <RefreshCw className="size-3.5" />
              إعادة المحاولة الآن
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
