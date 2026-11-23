"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LocateFixed,
  Lock,
  MapPin,
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
  DialogTitle,
} from "@/components/ui/dialog";
import { LocationPicker } from "@/components/shared/maps/google-map";
import type { PickedPlace } from "@/components/shared/maps/google-map-utils";

interface MapLocationPickerProps {
  lat: number | null;
  lng: number | null;
  fallbackCenter?: [number, number];
  onChange: (lat: number, lng: number) => void;
  /** A place picked from the Google search box (its address can prefill the form). */
  onPlace?: (place: PickedPlace) => void;
}

/** Wizard step 2: Google Maps picker (search, click, drag) + a GPS button with permission help. */
export default function MapLocationPicker({
  lat,
  lng,
  fallbackCenter = [30.0444, 31.2357],
  onChange,
  onPlace,
}: MapLocationPickerProps) {
  const [locating, setLocating] = useState(false);
  const [showPermissionDialog, setShowPermissionDialog] = useState(false);
  const areaCenter = fallbackCenter;

  // Execute geolocation with smart fallback (GPS first, then Wi-Fi/Network)
  const executeGetPosition = useCallback((highAccuracy: boolean) => {
    function getPos(accurate: boolean) {
      setLocating(true);

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const userLat = Number(pos.coords.latitude.toFixed(6));
          const userLng = Number(pos.coords.longitude.toFixed(6));

          // The map follows the new value on its own.
          onChange(userLat, userLng);

          toast.success("تم تحديد موقعك بدقة على الخريطة 📍");
          setLocating(false);
          setShowPermissionDialog(false);
        },
        (err) => {
          console.warn("[Geolocation Error]", err);
          // If high accuracy times out or fails (e.g. PC without dedicated GPS chip), fallback to network triangulation
          if (accurate && (err.code === 2 || err.code === 3)) {
            getPos(false);
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
          enableHighAccuracy: accurate,
          timeout: accurate ? 6000 : 10000,
          maximumAge: 60000,
        }
      );
    }

    getPos(highAccuracy);
  }, [onChange]);

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
  }, [executeGetPosition]);

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
          <span>ابحث عن العنوان، أو انقر على الخريطة واسحب الدبوس لتحديد موقع المغسلة بدقة:</span>
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
      <LocationPicker
        value={lat != null && lng != null ? { lat, lng } : null}
        onChange={(p) => onChange(p.lat, p.lng)}
        onPlace={onPlace}
        fallbackCenter={{ lat: areaCenter[0], lng: areaCenter[1] }}
        searchPlaceholder="ابحث عن عنوان المغسلة أو اسم المكان"
        className="h-[280px] sm:h-[320px]"
      />
      <p className="num text-[11px] text-muted-foreground" dir="ltr">
        {lat != null && lng != null ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` : "لم يُحدَّد الدبوس بعد"}
      </p>

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
