"use client";

import dynamic from "next/dynamic";

import { Skeleton } from "../../ui/skeleton";

/**
 * The maps, code-split: @vis.gl and the Google Maps API load only when a map is on screen.
 * Pass the same height class to the map; the placeholder takes `h-64` until it loads.
 */
const placeholder = () => <Skeleton className="h-64 w-full rounded-xl" />;

export const LocationsMap = dynamic(() => import("./google-map").then((m) => m.LocationsMap), { ssr: false, loading: placeholder });
export const LocationPicker = dynamic(() => import("./google-map").then((m) => m.LocationPicker), { ssr: false, loading: placeholder });

export { googleMapsUrl, type LatLng, type MapPoint, type PickedPlace } from "./google-map-utils";
