import { getStore } from "@/lib/db";
import { distanceMatrix, geocode } from "@/lib/geo";
import { defaultDurationFor } from "@/lib/parse/rules";
import { optimize, type OptimizerJob } from "@/lib/optimize";
import { suggestTeams, type RouteForSuggestion } from "@/lib/suggest";
import { toHHMM, toMinutes } from "@/lib/time";
import type {
  EffectiveJob,
  House,
  Job,
  Route,
  RouteStop,
  Schedule,
  ScheduleDetail,
} from "@/lib/types";

/** Applies the scheduler's corrections over the AI parse. Corrections win. */
export function toEffectiveJob(job: Job, house: House | undefined): EffectiveJob {
  const merged = { ...job.parsed, ...job.overrides };
  return {
    ...merged,
    id: job.id,
    houseId: job.houseId,
    customerId: job.customerId,
    confirmed: job.confirmed,
    town: house?.town ?? "Unknown",
    lat: house?.lat ?? null,
    lng: house?.lng ?? null,
    // A learned per-house estimate wins; otherwise the job type decides. A
    // linens drop-off is not an hour-and-a-half clean.
    durationMinutes: house?.durationEstimateMinutes ?? defaultDurationFor(merged.job_type),
  };
}

export async function getEffectiveJobs(scheduleId: string): Promise<EffectiveJob[]> {
  const store = getStore();
  const jobs = await store.listJobs(scheduleId);
  const houses = await store.getHouses([...new Set(jobs.map((j) => j.houseId))]);
  const byId = new Map(houses.map((h) => [h.id, h]));
  return jobs.map((job) => toEffectiveJob(job, byId.get(job.houseId)));
}

export async function getScheduleDetail(id: string): Promise<ScheduleDetail | null> {
  const store = getStore();
  const schedule = await store.getSchedule(id);
  if (!schedule) return null;

  const [jobs, routes] = await Promise.all([getEffectiveJobs(id), store.listRoutes(id)]);

  return {
    schedule,
    jobs,
    routes,
    unschedulable: schedule.unschedulable,
    totalDriveMinutes: schedule.totalDriveMinutes ?? 0,
  };
}

/**
 * Makes sure every house on this schedule has coordinates.
 *
 * Geocoding is cached in the `houses` table keyed by normalized address, so
 * after a few Saturdays nearly every lookup here is a no-op and costs nothing.
 */
async function ensureGeocoded(jobs: EffectiveJob[]): Promise<Map<string, House>> {
  const store = getStore();
  const houses = await store.getHouses([...new Set(jobs.map((j) => j.houseId))]);
  const byId = new Map(houses.map((h) => [h.id, h]));

  const missing = houses.filter((h) => h.lat === null || h.lng === null);
  for (const house of missing) {
    const result = await geocode(house.displayAddress, house.normalizedAddress, house.town);
    await store.updateHouse(house.id, {
      lat: result.lat,
      lng: result.lng,
      geoSource: result.source,
    });
    byId.set(house.id, { ...house, lat: result.lat, lng: result.lng, geoSource: result.source });
  }

  return byId;
}

export type BuildOutcome = {
  routes: Route[];
  totalDriveMinutes: number;
  unschedulable: { jobId: string; reason: string }[];
  distanceSource: "google" | "haversine";
  suggestionSource: "claude" | "fallback";
  /** Houses placed from the town gazetteer rather than actually geocoded. */
  estimatedLocations: number;
};

/**
 * Builds (or rebuilds) the route plan for a schedule.
 *
 * Order matters and is deliberate: geocode, then one distance matrix, then the
 * pure optimizer, then — only once the routes are fixed — the team-suggestion
 * call. The suggestion never influences routing.
 */
export async function buildRoutes(schedule: Schedule): Promise<BuildOutcome> {
  const store = getStore();
  const effective = await getEffectiveJobs(schedule.id);

  // Linens runs are dropped off, not cleaned inside a window, and a job with no
  // address cannot be routed at all. Both are surfaced rather than hidden.
  const routable = effective.filter((job) => job.address.trim().length > 0);
  const unroutable = effective
    .filter((job) => job.address.trim().length === 0)
    .map((job) => ({
      jobId: job.id,
      reason: "This job has no address, so it cannot be placed on a route.",
    }));

  const houses = await ensureGeocoded(routable);
  const estimatedLocations = [...houses.values()].filter((h) => h.geoSource === "gazetteer").length;

  const optimizerJobs: OptimizerJob[] = routable.map((job) => {
    const house = houses.get(job.houseId);
    return {
      id: job.id,
      town: job.town,
      lat: house?.lat ?? 0,
      lng: house?.lng ?? 0,
      windowStart: toMinutes(job.window_start),
      windowEnd: toMinutes(job.window_end),
      pinnedTime: job.pinned_time ? toMinutes(job.pinned_time) : null,
      durationMinutes: job.durationMinutes,
    };
  });

  // One matrix per build, cached against the schedule via the persisted stop
  // times, so drag-and-drop adjustments never re-call the API.
  const matrix = await distanceMatrix(
    optimizerJobs.map((job) => ({ lat: job.lat, lng: job.lng })),
  );

  const result = optimize({
    jobs: optimizerJobs,
    matrix: matrix.minutes,
    teamCount: schedule.teamCount,
  });

  // Team suggestions. Access codes are deliberately absent from this payload.
  const jobsById = new Map(routable.map((job) => [job.id, job]));
  const forSuggestion: RouteForSuggestion[] = result.routes.map((route, index) => ({
    routeId: `Route ${String.fromCharCode(65 + index)}`,
    stops: route.stops.map((stop) => {
      const job = jobsById.get(stop.jobId)!;
      return {
        houseId: job.houseId,
        customer: job.customer,
        town: job.town,
        arrival: toHHMM(stop.arrival),
      };
    }),
  }));

  const houseIds = [...new Set(routable.map((j) => j.houseId))];
  const [assignments, overrides] = await Promise.all([
    store.assignmentsForHouses(houseIds),
    store.recentOverrides(30),
  ]);

  const { suggestions, source: suggestionSource } = await suggestTeams(
    forSuggestion,
    assignments,
    overrides,
    schedule.teamCount,
  );
  const suggestionByRoute = new Map(suggestions.map((s) => [s.routeId, s]));

  const persisted = await store.replaceRoutes(
    schedule.id,
    result.routes.map((route, index) => {
      const suggestion = suggestionByRoute.get(`Route ${String.fromCharCode(65 + index)}`);
      const stops: RouteStop[] = route.stops.map((stop, position) => ({
        jobId: stop.jobId,
        position,
        estArrival: toHHMM(stop.arrival),
        estFinish: toHHMM(stop.finish),
        wasMovedByUser: false,
      }));
      return {
        position: index,
        suggestedTeam: suggestion?.team ?? index + 1,
        suggestionRationale: suggestion?.rationale ?? null,
        // Defaults to the suggestion; the scheduler can change it in one tap.
        finalTeam: suggestion?.team ?? index + 1,
        stops,
      };
    }),
  );

  const unschedulable = [...unroutable, ...result.unschedulable];

  await store.updateSchedule(schedule.id, {
    totalDriveMinutes: result.totalDriveMinutes,
    distanceSource: matrix.source,
    unschedulable,
    // Cached against the schedule so the board can recompute times on every
    // drag, client-side and server-side, without another distance API call.
    // Rounded to a tenth of a minute: full float precision would add ~150KB of
    // noise to every board page load and change no arrival time by a second.
    matrix: {
      jobIds: optimizerJobs.map((job) => job.id),
      minutes: matrix.minutes.map((row) => row.map((value) => Math.round(value * 10) / 10)),
    },
  });

  return {
    routes: persisted,
    totalDriveMinutes: result.totalDriveMinutes,
    unschedulable,
    distanceSource: matrix.source,
    suggestionSource,
    estimatedLocations,
  };
}
