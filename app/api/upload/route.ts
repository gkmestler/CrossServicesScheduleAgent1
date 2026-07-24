import { NextResponse } from "next/server";

import { getStore } from "@/lib/db";
import { newId } from "@/lib/db/store";
import { IngestError, readExport } from "@/lib/ingest";
import { parseJobs } from "@/lib/parse/claude";
import { extractTown, normalizeAddress } from "@/lib/parse/rules";
import { requireApiSession } from "@/lib/session";
import type { Job } from "@/lib/types";

/**
 * Reading 34 jobs' notes takes a while.
 *
 * 60 seconds is the ceiling on Vercel's Hobby plan — a higher value fails the
 * deployment outright rather than degrading. On Pro, raise this to 300.
 */
export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function POST(request: Request) {
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "That file is larger than 5MB. A weekly export should be a few kilobytes." },
      { status: 400 },
    );
  }

  let ingested;
  try {
    ingested = readExport(await file.arrayBuffer(), file.name);
  } catch (error) {
    if (error instanceof IngestError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: "That file could not be read." }, { status: 400 });
  }

  const store = getStore();

  // Correction memory: past fixes for customers present in *this* upload, so a
  // recurring customer stops parsing wrong after one correction.
  const customerNames = ingested.rows
    .map((row) => (row.customer ?? `${row.firstName ?? ""} ${row.lastName ?? ""}`).trim())
    .filter(Boolean);
  const corrections = await store.correctionsForCustomerNames([...new Set(customerNames)]);

  const parse = await parseJobs(ingested.rows, corrections);

  const scheduleDate = ingested.scheduleDate ?? new Date().toISOString().slice(0, 10);
  const schedule = await store.createSchedule({
    date: scheduleDate,
    teamCount: 8,
    status: "draft",
    finalizedAt: null,
    parseSource: parse.source,
    parseNote: parse.degradedReason ?? null,
    distanceSource: null,
    totalDriveMinutes: null,
    unschedulable: [],
    matrix: null,
  });

  const jobs: Job[] = [];
  for (let i = 0; i < ingested.rows.length; i += 1) {
    const raw = ingested.rows[i];
    const parsed = parse.jobs[i];

    const displayAddress = parsed.address.trim() || (raw.address ?? "").trim();
    const normalized = normalizeAddress(displayAddress || `unknown-${schedule.id}-${i}`);
    const town = displayAddress ? extractTown(displayAddress) : "Unknown";

    const house = await store.getOrCreateHouse({
      normalizedAddress: normalized,
      displayAddress: displayAddress || "(no address in export)",
      town,
    });
    const customer = await store.getOrCreateCustomer(parsed.customer, house.id);

    jobs.push({
      id: newId("job"),
      scheduleId: schedule.id,
      houseId: house.id,
      customerId: customer.id,
      raw,
      parsed,
      overrides: {},
      confirmed: false,
    });
  }

  await store.insertJobs(jobs);

  return NextResponse.json({
    scheduleId: schedule.id,
    jobCount: jobs.length,
    needsReview: jobs.filter((j) => j.parsed.confidence === "low").length,
    parseSource: parse.source,
    parseNote: parse.degradedReason ?? null,
    unrecognizedColumns: ingested.unrecognizedColumns,
  });
}
