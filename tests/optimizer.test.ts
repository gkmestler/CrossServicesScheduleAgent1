import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { estimateCoordinate } from "../lib/geo/gazetteer.ts";
import { haversineMinutes } from "../lib/geo/index.ts";
import { optimize, evaluateRoute, buildContext, type OptimizerJob } from "../lib/optimize/index.ts";
import {
  defaultDurationFor,
  extractTown,
  normalizeAddress,
  parseRowHeuristically,
} from "../lib/parse/rules.ts";
import { toMinutes } from "../lib/time.ts";
import type { RawRow } from "../lib/types.ts";

/**
 * The optimizer, run end to end against the July 25 fixture.
 *
 * No network: the fixture is parsed by the deterministic rules, placed by the
 * town gazetteer, and measured with haversine. That makes these tests fast and
 * hermetic, and it exercises exactly the fallback path a first-run install uses.
 */

const FIXTURE = path.join(import.meta.dirname, "..", "fixtures", "2026-07-25-changeover.csv");

/** A minimal CSV reader — enough for the fixture, and keeps SheetJS out of tests. */
function readFixture(): RawRow[] {
  const text = readFileSync(FIXTURE, "utf8").replace(/\r\n/g, "\n").trim();
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field);
      rows.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  record.push(field);
  rows.push(record);

  const [header, ...body] = rows;
  const index = (name: string) => header.indexOf(name);

  return body.map((cells) => ({
    date: cells[index("Date")],
    customer: cells[index("Customer")],
    firstName: cells[index("First Name")],
    lastName: cells[index("Last Name")],
    address: cells[index("Address")],
    description: cells[index("Description")],
    notes: cells[index("Notes")],
  }));
}

function buildJobs(): OptimizerJob[] {
  return readFixture().map((row) => {
    const parsed = parseRowHeuristically(row);
    const town = extractTown(parsed.address);
    const point = estimateCoordinate(normalizeAddress(parsed.address), town);
    return {
      id: `${parsed.customer}`,
      town,
      lat: point.lat,
      lng: point.lng,
      windowStart: toMinutes(parsed.window_start),
      windowEnd: toMinutes(parsed.window_end),
      pinnedTime: parsed.pinned_time ? toMinutes(parsed.pinned_time) : null,
      durationMinutes: defaultDurationFor(parsed.job_type),
    };
  });
}

function buildMatrix(jobs: OptimizerJob[]): number[][] {
  return jobs.map((from) => jobs.map((to) => haversineMinutes(from, to)));
}

/* -------------------------------------------------------------------------- */

test("the fixture is the shape the spec describes", () => {
  const jobs = buildJobs();
  assert.equal(jobs.length, 34, "34 jobs, as in the real Saturday");
  assert.equal(jobs.filter((j) => j.pinnedTime !== null).length >= 4, true, "about five time locks");
  const truroRegion = jobs.filter((j) => j.town === "Truro" || j.town === "North Truro");
  assert.equal(truroRegion.length, 7, "the Truro cluster is seven jobs");
  assert.equal(jobs.filter((j) => j.town === "Chatham").length > 0, true, "Chatham outliers exist");
});

test("every job is either placed on a route or reported as unschedulable", () => {
  const jobs = buildJobs();
  const result = optimize({ jobs, matrix: buildMatrix(jobs), teamCount: 8 });

  const placed = new Set(result.routes.flatMap((r) => r.stops.map((s) => s.jobId)));
  const flagged = new Set(result.unschedulable.map((u) => u.jobId));

  for (const job of jobs) {
    assert.ok(
      placed.has(job.id) || flagged.has(job.id),
      `${job.id} was neither scheduled nor reported — it vanished`,
    );
  }
});

test("no job is scheduled twice", () => {
  const jobs = buildJobs();
  const result = optimize({ jobs, matrix: buildMatrix(jobs), teamCount: 8 });

  const seen = new Set<string>();
  for (const route of result.routes) {
    for (const stop of route.stops) {
      assert.ok(!seen.has(stop.jobId), `${stop.jobId} appears on two routes`);
      seen.add(stop.jobId);
    }
  }
});

test("every scheduled stop finishes inside its window", () => {
  const jobs = buildJobs();
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const result = optimize({ jobs, matrix: buildMatrix(jobs), teamCount: 8 });

  for (const route of result.routes) {
    for (const stop of route.stops) {
      const job = byId.get(stop.jobId)!;
      assert.ok(
        stop.finish <= job.windowEnd,
        `${job.id} finishes at ${stop.finish} but its window closes at ${job.windowEnd}`,
      );
      assert.ok(
        stop.arrival >= job.windowStart,
        `${job.id} arrives at ${stop.arrival}, before its window opens at ${job.windowStart}`,
      );
    }
  }
});

test("pinned jobs land exactly on their locked time", () => {
  const jobs = buildJobs();
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const result = optimize({ jobs, matrix: buildMatrix(jobs), teamCount: 8 });

  const pinned = jobs.filter((j) => j.pinnedTime !== null);
  assert.ok(pinned.length > 0, "the fixture must contain time locks for this to mean anything");

  for (const route of result.routes) {
    for (const stop of route.stops) {
      const job = byId.get(stop.jobId)!;
      if (job.pinnedTime === null) continue;
      assert.equal(
        stop.arrival,
        job.pinnedTime,
        `${job.id} is pinned to ${job.pinnedTime} but was scheduled for ${stop.arrival}`,
      );
      assert.equal(stop.violation, null, `${job.id} is pinned but its stop reports a violation`);
    }
  }
});

const TRURO_REGION = new Set(["Truro", "North Truro"]);

test("a correct schedule keeps the Truro seven together", () => {
  const jobs = buildJobs();
  const result = optimize({ jobs, matrix: buildMatrix(jobs), teamCount: 8 });
  const byId = new Map(jobs.map((j) => [j.id, j]));

  const truroRoutes = result.routes.filter((route) =>
    route.stops.some((stop) => TRURO_REGION.has(byId.get(stop.jobId)!.town)),
  );

  // Seven 90-minute jobs cannot fit on one team inside a 9-4 window, so
  // "together" means a couple of dedicated routes, not literally one.
  assert.ok(
    truroRoutes.length <= 3,
    `Truro is spread across ${truroRoutes.length} teams — it should be at most 3`,
  );

  // And a Truro team must never also be sent to the far end of the Cape.
  // Wellfleet borders Truro, so a Wellfleet stop on a Truro run is fine;
  // Eastham and Chatham are the other direction entirely.
  for (const route of truroRoutes) {
    const towns = route.stops.map((stop) => byId.get(stop.jobId)!.town);
    for (const town of towns) {
      assert.ok(
        TRURO_REGION.has(town) || town === "Wellfleet",
        `a Truro route also goes to ${town}: ${towns.join(", ")}`,
      );
    }
  }
});

test("Chatham is not stranded", () => {
  const jobs = buildJobs();
  const result = optimize({ jobs, matrix: buildMatrix(jobs), teamCount: 8 });
  const byId = new Map(jobs.map((j) => [j.id, j]));

  const chatham = jobs.filter((j) => j.town === "Chatham");
  const placed = new Set(result.routes.flatMap((r) => r.stops.map((s) => s.jobId)));

  for (const job of chatham) {
    assert.ok(placed.has(job.id), `${job.id} in Chatham was left unscheduled`);
  }

  // Chatham is the far outlier, an hour from Truro. A team sent to both is the
  // exact failure this tool exists to prevent.
  for (const route of result.routes) {
    const towns = new Set(route.stops.map((stop) => byId.get(stop.jobId)!.town));
    assert.ok(
      !(towns.has("Chatham") && (towns.has("Truro") || towns.has("North Truro"))),
      `a route runs both Chatham and Truro: ${[...towns].join(", ")}`,
    );
  }
});

test("teams stay geographically tight", () => {
  const jobs = buildJobs();
  const result = optimize({ jobs, matrix: buildMatrix(jobs), teamCount: 8 });
  const byId = new Map(jobs.map((j) => [j.id, j]));

  for (const route of result.routes) {
    const towns = new Set(route.stops.map((stop) => byId.get(stop.jobId)!.town));
    assert.ok(
      towns.size <= 2,
      `a team covers ${towns.size} towns (${[...towns].join(", ")}) — that is the clustering failure this replaces`,
    );
  }
});

test("no team is given more work than the cap allows", () => {
  const jobs = buildJobs();
  const result = optimize({ jobs, matrix: buildMatrix(jobs), teamCount: 8 });

  // ceil(34/8) + 1 = 6, and the relaxed retry may add one more for a job that
  // would otherwise be unschedulable.
  for (const route of result.routes) {
    assert.ok(route.stops.length <= 7, `a team has ${route.stops.length} stops`);
  }
});

test("adding teams never leaves more jobs unplaced", () => {
  const jobs = buildJobs();
  const matrix = buildMatrix(jobs);

  let previous = Number.POSITIVE_INFINITY;
  for (const teamCount of [6, 7, 8, 9, 10, 12]) {
    const result = optimize({ jobs, matrix, teamCount });
    assert.ok(
      result.unschedulable.length <= previous,
      `${teamCount} teams left ${result.unschedulable.length} jobs unplaced, worse than the run before it`,
    );
    previous = result.unschedulable.length;
  }
});

test("34 jobs at 90 minutes each genuinely does not fit 8 teams, and it says so", () => {
  // This is a real property of the work, not a shortcoming of the optimizer.
  // Eight teams working a 9-4 window fit four 90-minute cleans each at the very
  // best — 32 slots for 34 jobs — and every pinned job that anchors a route at
  // 10am costs that route a slot. The tool's job is to say so plainly rather
  // than squeeze someone in and let a team discover it on the day.
  const jobs = buildJobs();
  const matrix = buildMatrix(jobs);

  const withEight = optimize({ jobs, matrix, teamCount: 8 });
  assert.ok(withEight.unschedulable.length > 0, "eight teams should not be enough here");
  assert.ok(
    withEight.unschedulable.length <= 6,
    `eight teams left ${withEight.unschedulable.length} jobs unplaced — the optimizer is leaving capacity on the table`,
  );
  for (const item of withEight.unschedulable) {
    assert.match(
      item.reason,
      /window|time lock/i,
      "every unplaced job needs a reason the scheduler can act on",
    );
  }

  // Ten teams is enough, which is what the editable team count is for.
  const withTen = optimize({ jobs, matrix, teamCount: 10 });
  assert.equal(withTen.unschedulable.length, 0, "ten teams should cover the whole Saturday");
});

test("the optimizer is deterministic", () => {
  const jobs = buildJobs();
  const matrix = buildMatrix(jobs);

  const a = optimize({ jobs, matrix, teamCount: 8 });
  const b = optimize({ jobs, matrix, teamCount: 8 });

  assert.deepEqual(
    a.routes.map((r) => r.stops.map((s) => s.jobId)),
    b.routes.map((r) => r.stops.map((s) => s.jobId)),
    "two runs over identical input produced different plans",
  );
});

test("it finishes fast enough to run inside a request", () => {
  const jobs = buildJobs();
  const matrix = buildMatrix(jobs);

  const started = process.hrtime.bigint();
  optimize({ jobs, matrix, teamCount: 8 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.ok(elapsedMs < 2000, `the optimizer took ${elapsedMs.toFixed(0)}ms`);
});

/* -------------------------------------------------------------------------- */
/* evaluateRoute — the function the board re-runs in the browser on every drag  */
/* -------------------------------------------------------------------------- */

test("evaluateRoute reports a violation instead of throwing when a stop runs late", () => {
  const jobs: OptimizerJob[] = [
    {
      id: "a",
      town: "Wellfleet",
      lat: 41.94,
      lng: -70.03,
      windowStart: toMinutes("10:00"),
      windowEnd: toMinutes("15:00"),
      pinnedTime: null,
      durationMinutes: 90,
    },
    {
      id: "b",
      town: "Chatham",
      lat: 41.68,
      lng: -69.96,
      // A narrow window that the drive from `a` cannot make.
      windowStart: toMinutes("10:00"),
      windowEnd: toMinutes("12:00"),
      pinnedTime: null,
      durationMinutes: 90,
    },
  ];
  const matrix = buildMatrix(jobs);
  const ctx = buildContext(jobs, matrix);

  const evaluation = evaluateRoute(["a", "b"], ctx);
  assert.equal(evaluation.feasible, false);
  assert.equal(evaluation.stops[0].violation, null);
  assert.ok(evaluation.stops[1].violation, "the late stop should carry a readable violation");
  assert.match(evaluation.stops[1].violation!, /window close/i);
});

test("evaluateRoute waits at a pinned stop rather than arriving early", () => {
  const jobs: OptimizerJob[] = [
    {
      id: "early",
      town: "Wellfleet",
      lat: 41.94,
      lng: -70.03,
      windowStart: toMinutes("09:00"),
      windowEnd: toMinutes("16:00"),
      pinnedTime: null,
      durationMinutes: 60,
    },
    {
      id: "pinned",
      town: "Wellfleet",
      lat: 41.945,
      lng: -70.035,
      windowStart: toMinutes("09:00"),
      windowEnd: toMinutes("16:00"),
      pinnedTime: toMinutes("13:00"),
      durationMinutes: 60,
    },
  ];
  const ctx = buildContext(jobs, buildMatrix(jobs));

  const evaluation = evaluateRoute(["early", "pinned"], ctx);
  assert.equal(evaluation.feasible, true);
  assert.equal(evaluation.stops[1].arrival, toMinutes("13:00"), "the team waits for the lock");
});
