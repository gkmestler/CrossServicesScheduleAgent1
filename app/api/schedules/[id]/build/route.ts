import { NextResponse } from "next/server";

import { failure } from "@/lib/errors";

import { getStore } from "@/lib/db";
import { buildRoutes } from "@/lib/schedule";
import { requireApiSession } from "@/lib/session";

/**
 * Geocoding, a distance matrix and a suggestion call.
 *
 * 60 seconds is the ceiling on Vercel's Hobby plan — a higher value fails the
 * deployment outright rather than degrading. On Pro, raise this to 300.
 */
export const maxDuration = 60;

async function handle(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  const { id } = await params;
  const store = getStore();
  const schedule = await store.getSchedule(id);
  if (!schedule) {
    return NextResponse.json({ error: "That schedule no longer exists." }, { status: 404 });
  }

  // Team count is editable from the board and rebuilds the routes on change.
  let teamCount = schedule.teamCount;
  try {
    const body = (await request.json()) as { teamCount?: unknown };
    if (typeof body.teamCount === "number" && Number.isInteger(body.teamCount)) {
      if (body.teamCount < 1 || body.teamCount > 30) {
        return NextResponse.json({ error: "Team count must be between 1 and 30." }, { status: 400 });
      }
      teamCount = body.teamCount;
    }
  } catch {
    // No body is fine — rebuild with the stored team count.
  }

  if (teamCount !== schedule.teamCount) {
    await store.updateSchedule(id, { teamCount });
  }

  const outcome = await buildRoutes({ ...schedule, teamCount });

  // The new plan comes back in full — routes, and the schedule row as it now
  // stands with its fresh drive-time matrix. The board applies both to what is
  // already on screen instead of reloading the page, which is what used to
  // leave the map drawing the previous grouping until a manual refresh.
  const rebuilt = await store.getSchedule(id);

  return NextResponse.json({
    ok: true,
    schedule: rebuilt,
    routes: outcome.routes,
    routeCount: outcome.routes.length,
    totalDriveMinutes: outcome.totalDriveMinutes,
    unschedulable: outcome.unschedulable,
    distanceSource: outcome.distanceSource,
    suggestionSource: outcome.suggestionSource,
    estimatedLocations: outcome.estimatedLocations,
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
