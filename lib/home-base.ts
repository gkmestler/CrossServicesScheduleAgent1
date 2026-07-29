import { geocode, type Coordinate } from "@/lib/geo";
import { normalizeAddress } from "@/lib/parse/rules";

/**
 * Every team starts and ends its day here. One address for the whole
 * operation, so it lives in code rather than as a per-schedule setting.
 */
export const HOME_BASE_ADDRESS = "2393 US-6 #1, Wellfleet, MA";
const HOME_BASE_TOWN = "Wellfleet";

let cached: Coordinate | null = null;

/** Geocoded once per server instance — the address never changes. */
export async function getHomeBaseCoordinate(): Promise<Coordinate> {
  if (cached) return cached;
  const result = await geocode(
    HOME_BASE_ADDRESS,
    normalizeAddress(HOME_BASE_ADDRESS),
    HOME_BASE_TOWN,
  );
  cached = { lat: result.lat, lng: result.lng };
  return cached;
}
