import { NextResponse } from "next/server";

import { failure } from "@/lib/errors";

import { getStore } from "@/lib/db";
import { getEffectiveJobs } from "@/lib/schedule";
import { requireApiSession } from "@/lib/session";
import type { Override } from "@/lib/types";

/**
 * Finalize: save the plan to history, including every manual change the
 * scheduler made relative to what the optimizer proposed.
 *
 * This is where the compounding happens. Assignments power next week's team
 * suggestions; overrides teach the suggestion prompt how he actually schedules;
 * duration learning widens the slot for houses he consistently gives more room.
 */
async function handle(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const store = getStore();
  const schedule = await store.getSchedule(id);
  if (!schedule) {
    return NextResponse.json({ error: "That schedule no longer exists." }, { status: 404 });
  }

  const [routes, jobs] = await Promise.all([store.listRoutes(id), getEffectiveJobs(id)]);
  const jobsById = new Map(jobs.map((job) => [job.id, job]));

  /* Assignment history: which team took which house. */
  const assignments = routes.flatMap((route) =>
    route.stops
      .map((stop) => {
        const job = jobsById.get(stop.jobId);
        const team = route.finalTeam ?? route.suggestedTeam;
        if (!job || team === null) return null;
        return { scheduleId: id, date: schedule.date, houseId: job.houseId, team };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null),
  );
  await store.recordAssignments(assignments);

  /* Preference notes: the diff between what was proposed and what he shipped. */
  const overrideRows: Omit<Override, "id" | "createdAt">[] = [];

  for (const route of routes) {
    const team = route.finalTeam ?? route.suggestedTeam;
    if (route.suggestedTeam !== null && team !== route.suggestedTeam) {
      overrideRows.push({
        scheduleId: id,
        date: schedule.date,
        kind: "reassigned_team",
        description: `Route ${route.position + 1} was suggested for Team ${route.suggestedTeam}; the scheduler gave it to Team ${team}.`,
      });
    }

    for (const stop of route.stops) {
      if (!stop.wasMovedByUser) continue;
      const job = jobsById.get(stop.jobId);
      if (!job) continue;
      overrideRows.push({
        scheduleId: id,
        date: schedule.date,
        kind: "moved_team",
        description: `The scheduler moved ${job.customer} (${job.town}) to Team ${team} at position ${stop.position + 1}, arriving ${stop.estArrival}.`,
      });
    }
  }

  await store.recordOverrides(overrideRows);

  /* Duration learning: where the scheduler consistently leaves a house more
     room than the default slot, store that as the house's estimate so the
     optimizer stops proposing something he will only have to fix again. */
  const learned: string[] = [];
  for (const route of routes) {
    for (const stop of route.stops) {
      if (!stop.wasMovedByUser) continue;
      const job = jobsById.get(stop.jobId);
      if (!job) continue;

      const [arrivalH, arrivalM] = stop.estArrival.split(":").map(Number);
      const [finishH, finishM] = stop.estFinish.split(":").map(Number);
      const slot = finishH * 60 + finishM - (arrivalH * 60 + arrivalM);

      if (slot > job.durationMinutes + 15) {
        await store.updateHouse(job.houseId, {
          durationEstimateMinutes: Math.round(slot),
        });
        learned.push(job.houseId);
      }
    }
  }

  await store.updateSchedule(id, { status: "final", finalizedAt: new Date().toISOString() });

  return NextResponse.json({
    ok: true,
    assignmentsRecorded: assignments.length,
    overridesRecorded: overrideRows.length,
    durationsLearned: learned.length,
  });
}

/**
 * A thrown error would otherwise become an HTML 500 that the client cannot
 * parse, leaving the scheduler with an unexplained failure. Everything comes
 * back as JSON with a cause.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return await handle(request, context);
  } catch (error) {
    return failure(error);
  }
}
