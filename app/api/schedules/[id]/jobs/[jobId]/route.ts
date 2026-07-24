import { NextResponse } from "next/server";

import { failure } from "@/lib/errors";

import { getStore } from "@/lib/db";
import { isValidTime } from "@/lib/time";
import { requireApiSession } from "@/lib/session";
import type { ParsedJob } from "@/lib/types";

/** The fields the review screen may edit. */
const EDITABLE = [
  "customer",
  "address",
  "job_type",
  "window_start",
  "window_end",
  "pinned_time",
  "access",
  "instructions",
] as const;

type EditableField = (typeof EDITABLE)[number];

const TIME_FIELDS: EditableField[] = ["window_start", "window_end", "pinned_time"];

async function handle(
  request: Request,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  const { jobId } = await params;
  const store = getStore();
  const job = await store.getJob(jobId);
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const overrides: Partial<ParsedJob> = { ...job.overrides };
  const correctionRows: {
    customerId: string;
    customerName: string;
    field: keyof ParsedJob;
    aiValue: string | null;
    userValue: string | null;
  }[] = [];

  for (const field of EDITABLE) {
    if (!(field in body)) continue;

    const incoming = body[field];
    const value =
      incoming === null || incoming === "" ? null : typeof incoming === "string" ? incoming.trim() : null;

    if (TIME_FIELDS.includes(field) && value !== null && !isValidTime(value)) {
      return NextResponse.json(
        { error: `"${value}" is not a time. Use 24-hour HH:MM, for example 14:30.` },
        { status: 400 },
      );
    }

    // window_start and window_end must not be null; the optimizer needs both.
    if ((field === "window_start" || field === "window_end") && value === null) {
      return NextResponse.json({ error: "A job needs both a start and an end time." }, { status: 400 });
    }

    const previous = job.overrides[field] ?? job.parsed[field];
    const previousText = previous === null || previous === undefined ? null : String(previous);
    if (previousText === value) continue;

    (overrides as Record<string, unknown>)[field] = value;

    // Every edit here is a correction. What Claude said vs what the scheduler
    // changed it to is fed back into the next parse for this customer.
    correctionRows.push({
      customerId: job.customerId,
      customerName: job.parsed.customer,
      field,
      aiValue: job.parsed[field] === null || job.parsed[field] === undefined ? null : String(job.parsed[field]),
      userValue: value,
    });
  }

  const confirmed = typeof body.confirmed === "boolean" ? body.confirmed : job.confirmed;

  await store.updateJob(jobId, { overrides, confirmed });
  await store.recordCorrections(correctionRows);

  return NextResponse.json({ ok: true, correctionsRecorded: correctionRows.length });
}

/**
 * A thrown error would otherwise become an HTML 500 that the client cannot
 * parse, leaving the scheduler with an unexplained failure. Everything comes
 * back as JSON with a cause.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; jobId: string }> },
) {
  try {
    return await handle(request, context);
  } catch (error) {
    return failure(error);
  }
}
