import { NextResponse } from "next/server";

import { getStore } from "@/lib/db";
import { failure } from "@/lib/errors";
import { requireApiSession } from "@/lib/session";

/**
 * Marks every job on a schedule reviewed, or clears them all.
 *
 * A Saturday can carry fifty jobs, and most of them parse cleanly. Ticking each
 * one to say "yes, I read that" is the tax; this is the one request that lets
 * the scheduler confirm the lot and then untick the handful worth arguing with.
 * One write rather than fifty PATCHes, so it cannot half-apply.
 */
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
      { error: "This schedule is finalized and can no longer be edited." },
      { status: 409 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  if (typeof body.confirmed !== "boolean") {
    return NextResponse.json({ error: "confirmed must be true or false." }, { status: 400 });
  }

  await store.setJobsConfirmed(id, body.confirmed);

  return NextResponse.json({ ok: true, confirmed: body.confirmed });
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    return await handle(request, context);
  } catch (error) {
    return failure(error);
  }
}
