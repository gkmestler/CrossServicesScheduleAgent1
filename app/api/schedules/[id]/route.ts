import { NextResponse } from "next/server";

import { getStore } from "@/lib/db";
import { failure } from "@/lib/errors";
import { requireApiSession } from "@/lib/session";

/**
 * Deleting a Saturday.
 *
 * Takes the schedule's jobs, routes and recorded history with it. What survives
 * is everything shared between Saturdays: houses, customers, their geocodes and
 * the per-customer parsing corrections. Deleting a bad upload should not cost
 * the learning built up from every other week.
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

  await store.deleteSchedule(id);
  return NextResponse.json({ ok: true });
}

/**
 * A thrown error would otherwise become an HTML 500 that the client cannot
 * parse, leaving the scheduler with an unexplained failure. Everything comes
 * back as JSON with a cause.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    return await handle(request, context);
  } catch (error) {
    return failure(error);
  }
}
