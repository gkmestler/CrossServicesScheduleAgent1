import { NextResponse } from "next/server";

import { failure } from "@/lib/errors";

import { getStore } from "@/lib/db";
import { buildContext, evaluateRoute } from "@/lib/optimize";
import { getEffectiveJobs } from "@/lib/schedule";
import { DEFAULT_DURATION_MINUTES } from "@/lib/parse/rules";
import { requireApiSession } from "@/lib/session";
import { toHHMM, toMinutes } from "@/lib/time";
import type { RouteStop } from "@/lib/types";

/**
 * Saves the board after a drag, a reorder or a team reassignment.
 *
 * The client has already recomputed times optimistically; this recomputes them
 * server-side from the same pure function so the stored plan is authoritative
 * and a stale client cannot persist wrong arrival times.
 */

type IncomingRoute = {
  id: string;
  finalTeam: number | null;
  /** Job ids in their new order. */
  jobIds: string[];
  /** Which stops the scheduler moved, so the diff can be recorded on finalize. */
  movedJobIds?: string[];
};

async function handle(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const store = getStore();
  const schedule = await store.getSchedule(id);
  if (!schedule) {
    return NextResponse.json({ error: "That schedule no longer exists." }, { status: 404 });
  }
  if (schedule.status === "final") {
    return NextResponse.json(
      { error: "This schedule is finalized. Nothing more can be changed on it." },
      { status: 409 },
    );
  }

  let incoming: IncomingRoute[];
  try {
    const body = (await request.json()) as { routes?: IncomingRoute[] };
    incoming = Array.isArray(body.routes) ? body.routes : [];
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const jobs = await getEffectiveJobs(id);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));

  // Every job must appear exactly once across all routes, or the plan has
  // silently lost or duplicated a house.
  const seen = new Set<string>();
  for (const route of incoming) {
    for (const jobId of route.jobIds) {
      if (!jobsById.has(jobId)) {
        return NextResponse.json({ error: "That plan refers to a job that is not on this schedule." }, { status: 400 });
      }
      if (seen.has(jobId)) {
        return NextResponse.json({ error: "That plan has the same job on two routes." }, { status: 400 });
      }
      seen.add(jobId);
    }
  }

  // Reuse the matrix cached at build time. A drag must never re-call the
  // distance API — the geography has not changed, only the ordering.
  const cached = schedule.matrix;
  if (!cached) {
    return NextResponse.json(
      { error: "This schedule has not been built yet, so there is nothing to rearrange." },
      { status: 409 },
    );
  }

  const orderedJobs = cached.jobIds
    .map((jobId) => jobsById.get(jobId))
    .filter((job): job is NonNullable<typeof job> => job !== undefined);

  const depotMinutes = cached.depotMinutes
    ? new Map(cached.jobIds.map((jobId, i) => [jobId, cached.depotMinutes![i]]))
    : undefined;

  const ctx = buildContext(
    orderedJobs.map((job) => ({
      id: job.id,
      town: job.town,
      lat: job.lat ?? 0,
      lng: job.lng ?? 0,
      windowStart: toMinutes(job.window_start),
      windowEnd: toMinutes(job.window_end),
      pinnedTime: job.pinned_time ? toMinutes(job.pinned_time) : null,
      durationMinutes: job.durationMinutes ?? DEFAULT_DURATION_MINUTES,
    })),
    cached.minutes,
    depotMinutes,
  );

  const existing = await store.listRoutes(id);
  const existingById = new Map(existing.map((route) => [route.id, route]));

  let totalDriveMinutes = 0;
  const violations: { jobId: string; reason: string }[] = [];

  const rebuilt = incoming
    .filter((route) => route.jobIds.length > 0)
    .map((route, position) => {
      const evaluation = evaluateRoute(route.jobIds, ctx);
      totalDriveMinutes += evaluation.driveMinutes;

      const moved = new Set(route.movedJobIds ?? []);
      const previous = existingById.get(route.id);
      const previouslyMoved = new Set(
        (previous?.stops ?? []).filter((s) => s.wasMovedByUser).map((s) => s.jobId),
      );

      const stops: RouteStop[] = evaluation.stops.map((stop, stopPosition) => {
        if (stop.violation) violations.push({ jobId: stop.jobId, reason: stop.violation });
        return {
          jobId: stop.jobId,
          position: stopPosition,
          estArrival: toHHMM(stop.arrival),
          estFinish: toHHMM(stop.finish),
          wasMovedByUser: moved.has(stop.jobId) || previouslyMoved.has(stop.jobId),
        };
      });

      return {
        position,
        suggestedTeam: previous?.suggestedTeam ?? null,
        suggestionRationale: previous?.suggestionRationale ?? null,
        finalTeam: route.finalTeam,
        stops,
      };
    });

  const saved = await store.replaceRoutes(id, rebuilt);

  // Anything still unplaced plus anything now violating its window.
  const placed = new Set(rebuilt.flatMap((route) => route.stops.map((stop) => stop.jobId)));
  const unplaced = jobs
    .filter((job) => !placed.has(job.id))
    .map((job) => ({
      jobId: job.id,
      reason:
        job.lat === null
          ? "This job has no address, so it cannot be placed on a route."
          : "Set aside — not currently on any team.",
    }));

  const unschedulable = [...unplaced, ...violations];
  await store.updateSchedule(id, { totalDriveMinutes, unschedulable });

  return NextResponse.json({ ok: true, routes: saved, totalDriveMinutes, unschedulable });
}

/**
 * A thrown error would otherwise become an HTML 500 that the client cannot
 * parse, leaving the scheduler with an unexplained failure. Everything comes
 * back as JSON with a cause.
 */
export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return await handle(request, context);
  } catch (error) {
    return failure(error);
  }
}
