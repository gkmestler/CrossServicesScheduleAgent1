/**
 * Town centroids for the towns this operation covers.
 *
 * These exist so the app still produces a sane, town-clustered plan when no
 * Google key is configured. They are NOT a substitute for geocoding: a house
 * placed from the gazetteer is at its town centre plus a deterministic offset,
 * not at its actual address. Anything routed this way is labelled "estimated"
 * in the UI so the scheduler is never misled about it.
 */

export type Coordinate = { lat: number; lng: number };

export const TOWN_CENTROIDS: Record<string, Coordinate> = {
  wellfleet: { lat: 41.9376, lng: -70.0322 },
  truro: { lat: 41.9959, lng: -70.0492 },
  "north truro": { lat: 42.0362, lng: -70.09 },
  eastham: { lat: 41.8301, lng: -69.9739 },
  chatham: { lat: 41.6821, lng: -69.9597 },
  orleans: { lat: 41.7898, lng: -69.9895 },
  brewster: { lat: 41.7601, lng: -70.0819 },
  provincetown: { lat: 42.0584, lng: -70.1787 },
  harwich: { lat: 41.6862, lng: -70.0759 },
  dennis: { lat: 41.7351, lng: -70.1936 },
};

/** Wellfleet is the dominant town, so it is the fallback of last resort. */
const DEFAULT_CENTROID = TOWN_CENTROIDS.wellfleet;

/** Stable 32-bit hash so the same address always lands on the same point. */
function hashString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Places an address near its town centre, offset deterministically by an
 * address hash so two different houses on the same street are not stacked on
 * one point (which would make the optimizer's ordering arbitrary).
 *
 * The offset is up to roughly 2.5km, which is about the scale of a Cape village.
 */
export function estimateCoordinate(normalizedAddress: string, town: string): Coordinate {
  const centroid = TOWN_CENTROIDS[town.toLowerCase()] ?? DEFAULT_CENTROID;
  const hash = hashString(normalizedAddress);

  // Two independent values in [-1, 1) from different halves of the hash.
  const dx = ((hash & 0xffff) / 0x8000) - 1;
  const dy = (((hash >>> 16) & 0xffff) / 0x8000) - 1;

  const latSpread = 0.022; // ~2.4 km
  const lngSpread = 0.03; // ~2.5 km at this latitude

  return {
    lat: centroid.lat + dy * latSpread,
    lng: centroid.lng + dx * lngSpread,
  };
}
