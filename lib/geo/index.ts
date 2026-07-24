/**
 * Geocoding and drive-time distances.
 *
 * Deliberately one swappable module with a straight-line fallback, so a missing
 * or misbehaving Google key degrades to estimates rather than breaking schedule
 * builds. Every result carries the source it came from, and the UI shows it.
 *
 * Claude is never asked to do any of this. A language model guessing lat/lngs or
 * drive times quietly produces bad routes, which is worse than no routes.
 */

import { estimateCoordinate, type Coordinate } from "@/lib/geo/gazetteer";

export type { Coordinate };

export type GeocodeResult = Coordinate & { source: "google" | "gazetteer" };

/** Square matrix of drive times in minutes, indexed the same as the input. */
export type DistanceMatrix = {
  minutes: number[][];
  source: "google" | "haversine";
};

const GOOGLE_KEY = () => process.env.GOOGLE_MAPS_API_KEY;

/* -------------------------------------------------------------------------- */
/* Geocoding                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolves one address. Callers cache the result in the `houses` table keyed by
 * normalized address, so after a few Saturdays nearly every lookup is a cache
 * hit and costs nothing.
 */
export async function geocode(
  address: string,
  normalizedAddress: string,
  town: string,
): Promise<GeocodeResult> {
  const key = GOOGLE_KEY();
  if (!key || !address.trim()) {
    return { ...estimateCoordinate(normalizedAddress, town), source: "gazetteer" };
  }

  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", address);
    // Bias to Cape Cod so a bare street name cannot land in another state.
    url.searchParams.set("components", "administrative_area:MA|country:US");
    url.searchParams.set("key", key);

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`geocoder returned ${response.status}`);

    const body = (await response.json()) as {
      status: string;
      results?: { geometry?: { location?: { lat: number; lng: number } } }[];
    };

    const location = body.results?.[0]?.geometry?.location;
    if (body.status !== "OK" || !location) {
      throw new Error(`geocoder status ${body.status}`);
    }

    return { lat: location.lat, lng: location.lng, source: "google" };
  } catch {
    // Never surface the address or the key in an error; just degrade.
    return { ...estimateCoordinate(normalizedAddress, town), source: "gazetteer" };
  }
}

/* -------------------------------------------------------------------------- */
/* Distances                                                                  */
/* -------------------------------------------------------------------------- */

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: Coordinate, b: Coordinate): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Outer Cape roads are winding and largely single-carriageway; Route 6 is the
 * only through road. 1.35 detour factor at 45 km/h is a reasonable straight-line
 * approximation, and errs slightly long rather than short.
 */
const DETOUR_FACTOR = 1.35;
const AVERAGE_SPEED_KMH = 45;

export function haversineMinutes(a: Coordinate, b: Coordinate): number {
  const km = haversineKm(a, b) * DETOUR_FACTOR;
  return (km / AVERAGE_SPEED_KMH) * 60;
}

function haversineMatrix(points: Coordinate[]): DistanceMatrix {
  const minutes = points.map((from) => points.map((to) => haversineMinutes(from, to)));
  return { minutes, source: "haversine" };
}

/**
 * Routes API computeRouteMatrix caps a request at 625 elements, and ~35 stops is
 * 1225, so requests are chunked by destination block.
 */
const MAX_ELEMENTS_PER_REQUEST = 600;

type MatrixElement = {
  originIndex: number;
  destinationIndex: number;
  duration?: string;
  condition?: string;
};

async function googleMatrixChunk(
  origins: Coordinate[],
  destinations: Coordinate[],
  key: string,
): Promise<MatrixElement[]> {
  const waypoint = (c: Coordinate) => ({
    waypoint: { location: { latLng: { latitude: c.lat, longitude: c.lng } } },
  });

  const response = await fetch(
    "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
      },
      body: JSON.stringify({
        origins: origins.map(waypoint),
        destinations: destinations.map(waypoint),
        travelMode: "DRIVE",
        // Traffic-unaware keeps this cheap and deterministic; the plan is built
        // days ahead, so live traffic would be noise rather than signal.
        routingPreference: "TRAFFIC_UNAWARE",
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );

  if (!response.ok) throw new Error(`route matrix returned ${response.status}`);
  return (await response.json()) as MatrixElement[];
}

/**
 * One matrix per schedule build. Cached against the schedule so drag-and-drop
 * adjustments never re-call the API.
 */
export async function distanceMatrix(points: Coordinate[]): Promise<DistanceMatrix> {
  const key = GOOGLE_KEY();
  if (!key || points.length === 0) return haversineMatrix(points);

  try {
    const n = points.length;
    const blockSize = Math.max(1, Math.floor(MAX_ELEMENTS_PER_REQUEST / n));
    const minutes: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(NaN));

    for (let start = 0; start < n; start += blockSize) {
      const destinationSlice = points.slice(start, start + blockSize);
      const elements = await googleMatrixChunk(points, destinationSlice, key);

      for (const element of elements) {
        if (element.condition && element.condition !== "ROUTE_EXISTS") continue;
        if (!element.duration) continue;
        const seconds = Number.parseFloat(element.duration.replace(/s$/, ""));
        if (!Number.isFinite(seconds)) continue;
        minutes[element.originIndex][start + element.destinationIndex] = seconds / 60;
      }
    }

    // Backfill anything Google could not route (islands, bad geocodes) rather
    // than leaving a NaN that would silently poison the optimizer's arithmetic.
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        if (i === j) {
          minutes[i][j] = 0;
        } else if (!Number.isFinite(minutes[i][j])) {
          minutes[i][j] = haversineMinutes(points[i], points[j]);
        }
      }
    }

    return { minutes, source: "google" };
  } catch {
    return haversineMatrix(points);
  }
}
