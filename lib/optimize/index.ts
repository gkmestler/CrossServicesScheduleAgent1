/**
 * Route optimization: a vehicle routing problem with time windows.
 *
 * At ~35 jobs and ~8 teams this is small enough for a good heuristic, which
 * runs in well under a second. Deliberately pure and dependency-free: no
 * network, no clock, no randomness. That makes it unit-testable against the
 * real export, and lets the schedule board re-run `evaluateRoute` in the
 * browser on every drag without another round trip.
 *
 * Claude is not involved in any of this. Distance arithmetic belongs in code.
 *
 * Two deliberate properties of the time model, both chosen by the scheduler:
 *
 *  1. Drive time is measured but never added to the clock. It decides who is
 *     grouped with whom and in what order — that is the whole point of the
 *     distance matrix — but stops are stacked back to back, on the assumption
 *     that the 90-minute average already absorbs the hop between houses. So a
 *     day reads 10:00, 11:30, 1:00 rather than 10:00, 11:33, 1:07.
 *  2. Nothing is ever refused. A job that will not fit its window is scheduled
 *     anyway and carries a violation saying so. The scheduler would rather see
 *     a full day with three stops flagged than a short day and a tray of
 *     rejects.
 */

export type OptimizerJob = {
  id: string;
  town: string;
  lat: number;
  lng: number;
  /** Minutes since midnight. */
  windowStart: number;
  windowEnd: number;
  /** Fixed appointment time, or null. Pinned jobs anchor a route. */
  pinnedTime: number | null;
  durationMinutes: number;
};

export type OptimizerInput = {
  jobs: OptimizerJob[];
  /** Drive times in minutes, indexed the same as `jobs`. */
  matrix: number[][];
  teamCount: number;
  /** Defaults to ceil(jobs / teams) + 1. */
  maxJobsPerTeam?: number;
};

export type EvaluatedStop = {
  jobId: string;
  arrival: number;
  finish: number;
  /**
   * Minutes driven to reach this stop from the previous one, 0 for the first.
   * Reported, not spent: it is not part of `arrival`.
   */
  driveMinutes: number;
  /** Set when this stop runs past its window close, or misses a time lock. */
  violation: string | null;
};

export type RouteEvaluation = {
  stops: EvaluatedStop[];
  /**
   * Real driving between these stops, in order. Not part of the arrival times —
   * it is the cost the routing minimizes, and what the board reports separately.
   */
  driveMinutes: number;
  /** Minutes past their window close, summed over every stop that runs over. */
  lateMinutes: number;
  /** Minutes a time lock is missed by because the stop before it overran. */
  missedLockMinutes: number;
  /** True when every stop lands inside its window and every lock is kept. */
  feasible: boolean;
};

export type OptimizedRoute = {
  position: number;
  stops: EvaluatedStop[];
  driveMinutes: number;
};

export type OptimizerResult = {
  routes: OptimizedRoute[];
  /**
   * Problems worth the scheduler's attention, by job. Every job is on a route,
   * so in practice these are stops running outside their window rather than
   * jobs left behind.
   */
  unschedulable: { jobId: string; reason: string }[];
  totalDriveMinutes: number;
};

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/** Index lookup so evaluation does not scan the job list per stop. */
export type EvalContext = {
  jobs: Map<string, OptimizerJob>;
  index: Map<string, number>;
  matrix: number[][];
};

export function buildContext(jobs: OptimizerJob[], matrix: number[][]): EvalContext {
  const jobMap = new Map<string, OptimizerJob>();
  const index = new Map<string, number>();
  jobs.forEach((job, i) => {
    jobMap.set(job.id, job);
    index.set(job.id, i);
  });
  return { jobs: jobMap, index, matrix };
}

function travel(ctx: EvalContext, fromId: string, toId: string): number {
  const from = ctx.index.get(fromId);
  const to = ctx.index.get(toId);
  if (from === undefined || to === undefined) return 0;
  const value = ctx.matrix[from]?.[to];
  return Number.isFinite(value) ? value : 0;
}

/**
 * Walks an ordered list of job ids and computes arrival and finish times.
 *
 * A team has no depot — the day starts when they reach their first house, at
 * the moment that window opens. Every stop after it begins when the one before
 * it finishes: travel is measured and reported, but not spent (see the note at
 * the top of this file). A pinned job is arrived at exactly on its time,
 * waiting if necessary.
 *
 * Running past a window close is never an error here — it is a violation on
 * that stop, which the board renders in place and the export sheet prints. This
 * is also what the board calls client-side on every drop, which is why it
 * reports rather than throws.
 */
export function evaluateRoute(order: string[], ctx: EvalContext): RouteEvaluation {
  const stops: EvaluatedStop[] = [];
  let driveTotal = 0;
  let lateMinutes = 0;
  let missedLockMinutes = 0;
  let previousFinish: number | null = null;
  let previousId: string | null = null;

  for (const jobId of order) {
    const job = ctx.jobs.get(jobId);
    if (!job) continue;

    const drive = previousId === null ? 0 : travel(ctx, previousId, jobId);
    driveTotal += drive;

    const earliest =
      previousFinish === null ? job.windowStart : Math.max(job.windowStart, previousFinish);

    let arrival: number;
    let violation: string | null = null;

    if (job.pinnedTime !== null) {
      arrival = job.pinnedTime;
      if (job.pinnedTime < job.windowStart) {
        lateMinutes += job.windowStart - job.pinnedTime;
        violation = `Locked at ${formatClock(job.pinnedTime)}, before the ${formatClock(job.windowStart)} window opens.`;
      }
      if (earliest > job.pinnedTime) {
        missedLockMinutes += earliest - job.pinnedTime;
        violation = `The stop before this one runs to ${formatClock(earliest)}, past this ${formatClock(job.pinnedTime)} time lock.`;
      }
    } else {
      arrival = earliest;
    }

    const finish = arrival + job.durationMinutes;
    if (finish > job.windowEnd) {
      lateMinutes += finish - job.windowEnd;
      // The window overrun is the more actionable of the two, so it wins when a
      // stop has both.
      violation =
        job.pinnedTime !== null
          ? `Locked at ${formatClock(job.pinnedTime)}, so it runs to ${formatClock(finish)} — past the ${formatClock(job.windowEnd)} window close.`
          : `Runs to ${formatClock(finish)}, past the ${formatClock(job.windowEnd)} window close.`;
    }

    stops.push({ jobId, arrival, finish, driveMinutes: drive, violation });

    // Once jobs stack past their windows a time lock can sit earlier than the
    // stop before it. The clock must not rewind, or every stop after the lock
    // would be reported earlier than it can possibly happen.
    previousFinish = previousFinish === null ? finish : Math.max(finish, previousFinish);
    previousId = jobId;
  }

  return {
    stops,
    driveMinutes: driveTotal,
    lateMinutes,
    missedLockMinutes,
    feasible: lateMinutes === 0 && missedLockMinutes === 0,
  };
}

function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes) % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

/**
 * What every rearrangement is judged on: how far the team drives, how far past
 * their windows the stops run, and how badly any time lock is broken.
 *
 * A move must lower `drive` without raising either of the other two. Keeping
 * locks separate from ordinary lateness matters: summed together, a move could
 * "pay" for breaking a 10am appointment with time saved elsewhere on the day,
 * and put two 10am locks on one team.
 */
type RouteCost = { drive: number; late: number; missedLocks: number };

function measure(order: string[], ctx: EvalContext): RouteCost {
  const evaluation = evaluateRoute(order, ctx);
  return {
    drive: evaluation.driveMinutes,
    late: evaluation.lateMinutes,
    missedLocks: evaluation.missedLockMinutes,
  };
}

/** True when `next` keeps every promise `current` kept, or more of them. */
function noWorse(next: RouteCost, current: RouteCost): boolean {
  return next.late <= current.late + 0.01 && next.missedLocks <= current.missedLocks + 0.01;
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Picks one seed job per team, spread as far apart as possible.
 *
 * Farthest-point sampling starting from the densest town does exactly what the
 * scheduler does by hand: the first seed lands in the dominant town (Wellfleet),
 * then the outliers get their own routes (Chatham, Truro, Provincetown), and the
 * remaining seeds fill back into the dense core. Pinned jobs are preferred as
 * seeds because they cannot move anyway.
 */
function pickSeeds(jobs: OptimizerJob[], ctx: EvalContext, teamCount: number): string[] {
  if (jobs.length === 0) return [];

  const townCounts = new Map<string, number>();
  for (const job of jobs) {
    townCounts.set(job.town, (townCounts.get(job.town) ?? 0) + 1);
  }
  const dominantTown = [...townCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  // The first seed is the job most central to the dominant town, so the biggest
  // cluster gets an anchor rather than being carved up by the outlier routes.
  const dominantJobs = jobs.filter((j) => j.town === dominantTown);
  const pool = dominantJobs.length > 0 ? dominantJobs : jobs;
  const centroid = {
    lat: pool.reduce((sum, j) => sum + j.lat, 0) / pool.length,
    lng: pool.reduce((sum, j) => sum + j.lng, 0) / pool.length,
  };
  const first = pool.reduce((best, job) => {
    const d = (job.lat - centroid.lat) ** 2 + (job.lng - centroid.lng) ** 2;
    const bestD = (best.lat - centroid.lat) ** 2 + (best.lng - centroid.lng) ** 2;
    return d < bestD ? job : best;
  });

  const seeds = [first.id];
  const remaining = jobs.filter((j) => j.id !== first.id);

  while (seeds.length < teamCount && remaining.length > 0) {
    let bestJob = remaining[0];
    let bestScore = -Infinity;

    for (const job of remaining) {
      const nearestSeed = Math.min(...seeds.map((seedId) => travel(ctx, seedId, job.id)));
      // Nudge pinned jobs toward being seeds: they anchor a route by definition.
      const score = nearestSeed + (job.pinnedTime !== null ? 5 : 0);
      if (score > bestScore) {
        bestScore = score;
        bestJob = job;
      }
    }

    seeds.push(bestJob.id);
    remaining.splice(remaining.indexOf(bestJob), 1);
  }

  return seeds;
}

/* -------------------------------------------------------------------------- */
/* Insertion                                                                  */
/* -------------------------------------------------------------------------- */

type InsertionCandidate = { routeIndex: number; position: number; cost: number };

/**
 * Cheapest place to add one job, measured in added drive minutes.
 *
 * `allowLate` is what lets the plan hold every job. Left false, this is the
 * original behaviour: only slots where the whole route still lands inside its
 * windows are considered, so the jobs that genuinely fit are placed exactly as
 * they always were. Turned on for the leftovers afterwards, no slot is refused
 * — geography still picks the spot, and the overrun is reported on the stop.
 *
 * Even in overflow, a slot that would knock a time lock off its hour loses to
 * one that would not. A lock is a commitment to a customer; a window is a
 * preference.
 */
function bestInsertion(
  jobId: string,
  routes: string[][],
  ctx: EvalContext,
  maxJobsPerTeam: number,
  allowLate = false,
): InsertionCandidate | null {
  let best: InsertionCandidate | null = null;
  let bestLockDelta = Infinity;

  for (let r = 0; r < routes.length; r += 1) {
    const route = routes[r];
    if (route.length >= maxJobsPerTeam) continue;

    const base = measure(route, ctx);

    for (let position = 0; position <= route.length; position += 1) {
      const candidate = [...route.slice(0, position), jobId, ...route.slice(position)];
      const evaluation = evaluateRoute(candidate, ctx);
      if (!allowLate && !evaluation.feasible) continue;

      const lockDelta = evaluation.missedLockMinutes - base.missedLocks;
      const cost = evaluation.driveMinutes - base.drive;

      const better =
        best === null ||
        lockDelta < bestLockDelta - 0.01 ||
        (lockDelta <= bestLockDelta + 0.01 && cost < best.cost);

      if (better) {
        best = { routeIndex: r, position, cost };
        bestLockDelta = lockDelta;
      }
    }
  }

  return best;
}

/* -------------------------------------------------------------------------- */
/* Improvement                                                                */
/* -------------------------------------------------------------------------- */

/** 2-opt within a single route: reverse a segment, keep it if it helps. */
function twoOpt(route: string[], ctx: EvalContext): string[] {
  if (route.length < 4) return route;

  let current = route;
  let cost = measure(current, ctx);
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 0; i < current.length - 1; i += 1) {
      for (let k = i + 1; k < current.length; k += 1) {
        const candidate = [
          ...current.slice(0, i),
          ...current.slice(i, k + 1).reverse(),
          ...current.slice(k + 1),
        ];
        const next = measure(candidate, ctx);
        // Shorter, and no worse on windows or locks. A route with stops already
        // running over still gets tidied up; it just may not be made any later.
        if (next.drive < cost.drive - 0.01 && noWorse(next, cost)) {
          current = candidate;
          cost = next;
          improved = true;
        }
      }
    }
  }

  return current;
}

/** Move one job to a better place on another route. */
function relocateBetweenRoutes(
  routes: string[][],
  ctx: EvalContext,
  maxJobsPerTeam: number,
): boolean {
  for (let from = 0; from < routes.length; from += 1) {
    const fromBefore = measure(routes[from], ctx);

    for (let stopIndex = 0; stopIndex < routes[from].length; stopIndex += 1) {
      const jobId = routes[from][stopIndex];
      const without = [...routes[from].slice(0, stopIndex), ...routes[from].slice(stopIndex + 1)];
      const fromAfter = measure(without, ctx);
      const savedHere = fromBefore.drive - fromAfter.drive;

      for (let to = 0; to < routes.length; to += 1) {
        if (to === from) continue;
        if (routes[to].length >= maxJobsPerTeam) continue;

        const toBefore = measure(routes[to], ctx);
        for (let position = 0; position <= routes[to].length; position += 1) {
          const candidate = [
            ...routes[to].slice(0, position),
            jobId,
            ...routes[to].slice(position),
          ];
          const toAfter = measure(candidate, ctx);

          const addedThere = toAfter.drive - toBefore.drive;

          // Both routes are weighed together: a move must not hand one team's
          // saved minutes to the other as a broken window or a missed lock.
          const before = {
            drive: fromBefore.drive + toBefore.drive,
            late: fromBefore.late + toBefore.late,
            missedLocks: fromBefore.missedLocks + toBefore.missedLocks,
          };
          const after = {
            drive: fromAfter.drive + toAfter.drive,
            late: fromAfter.late + toAfter.late,
            missedLocks: fromAfter.missedLocks + toAfter.missedLocks,
          };

          if (addedThere < savedHere - 0.01 && noWorse(after, before)) {
            routes[from] = without;
            routes[to] = candidate;
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** Swap a pair of jobs between two routes when it shortens the total. */
function swapBetweenRoutes(routes: string[][], ctx: EvalContext): boolean {
  for (let a = 0; a < routes.length; a += 1) {
    for (let b = a + 1; b < routes.length; b += 1) {
      const beforeA = measure(routes[a], ctx);
      const beforeB = measure(routes[b], ctx);
      const before = {
        drive: beforeA.drive + beforeB.drive,
        late: beforeA.late + beforeB.late,
        missedLocks: beforeA.missedLocks + beforeB.missedLocks,
      };

      for (let i = 0; i < routes[a].length; i += 1) {
        for (let j = 0; j < routes[b].length; j += 1) {
          const nextA = [...routes[a]];
          const nextB = [...routes[b]];
          [nextA[i], nextB[j]] = [nextB[j], nextA[i]];

          const costA = measure(nextA, ctx);
          const costB = measure(nextB, ctx);
          const after = {
            drive: costA.drive + costB.drive,
            late: costA.late + costB.late,
            missedLocks: costA.missedLocks + costB.missedLocks,
          };

          if (after.drive < before.drive - 0.01 && noWorse(after, before)) {
            routes[a] = nextA;
            routes[b] = nextB;
            return true;
          }
        }
      }
    }
  }
  return false;
}

/**
 * 2-opt within each route, then relocations and swaps between them, until
 * nothing improves or the budget runs out.
 */
function improve(routes: string[][], ctx: EvalContext, maxJobsPerTeam: number): void {
  const MAX_PASSES = 40;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    for (let r = 0; r < routes.length; r += 1) {
      routes[r] = twoOpt(routes[r], ctx);
    }
    const moved = relocateBetweenRoutes(routes, ctx, maxJobsPerTeam);
    const swapped = moved ? false : swapBetweenRoutes(routes, ctx);
    if (!moved && !swapped) break;
  }
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The order flexible jobs are offered to the greedy insertion in.
 *
 * This matters far more than it looks. A team's day starts when it reaches its
 * first house, so whether a 9-4 job or a 10-3 job lands on a route first decides
 * whether that route fits three stops or four. No single ordering wins on every
 * input, so the optimizer runs all of them and keeps the best plan — at this
 * size that costs a few milliseconds and removes a whole class of bad days.
 */
const ORDERINGS: { name: string; compare: (a: OptimizerJob, b: OptimizerJob) => number }[] = [
  {
    // Earliest opening first: gets routes started at 9am rather than 10am,
    // which is usually worth a whole extra stop per team.
    name: "earliest-open",
    compare: (a, b) => a.windowStart - b.windowStart || slack(a) - slack(b),
  },
  {
    // Tightest window first: the classic most-constrained-first rule.
    name: "tightest-window",
    compare: (a, b) => slack(a) - slack(b) || a.windowStart - b.windowStart,
  },
  {
    // Earliest deadline first: standard for routing with time windows.
    name: "earliest-close",
    compare: (a, b) => a.windowEnd - b.windowEnd || a.windowStart - b.windowStart,
  },
  {
    // Longest job first: bin-packing's first-fit-decreasing, which is good when
    // durations vary (a linens drop next to a full changeover).
    name: "longest-first",
    compare: (a, b) => b.durationMinutes - a.durationMinutes || a.windowStart - b.windowStart,
  },
];

function slack(job: OptimizerJob): number {
  return job.windowEnd - job.windowStart - job.durationMinutes;
}

type Attempt = {
  routes: string[][];
  unplaced: { jobId: string; reason: string }[];
  driveMinutes: number;
  /** Stops scheduled outside their window. The primary thing to minimize. */
  lateStops: number;
};

function attempt(
  placeable: OptimizerJob[],
  ctx: EvalContext,
  teamCount: number,
  maxJobsPerTeam: number,
  compare: (a: OptimizerJob, b: OptimizerJob) => number,
): Attempt {
  const unplaced: { jobId: string; reason: string }[] = [];
  /** Jobs that found no slot inside a window. Placed anyway, once, at the end. */
  const overflow: OptimizerJob[] = [];

  // Step 1 and 2: geographic seeds, one per team, preferring pinned jobs.
  const seedIds = pickSeeds(placeable, ctx, teamCount);
  const routes: string[][] = Array.from({ length: teamCount }, () => []);
  seedIds.forEach((seedId, i) => {
    routes[i] = [seedId];
  });
  const seeded = new Set(seedIds);

  // Pinned jobs are fixed appointments, not flexible windows, so they anchor
  // routes before anything flexible competes for the same slots. Earliest pin
  // first, so a 9am lock is not blocked by a 1pm one.
  const pendingPinned = placeable
    .filter((j) => j.pinnedTime !== null && !seeded.has(j.id))
    .sort((a, b) => (a.pinnedTime ?? 0) - (b.pinnedTime ?? 0));

  for (const job of pendingPinned) {
    const insertion = bestInsertion(job.id, routes, ctx, maxJobsPerTeam);
    if (insertion) {
      routes[insertion.routeIndex].splice(insertion.position, 0, job.id);
    } else {
      overflow.push(job);
    }
  }

  // Step 3: greedy insertion of the flexible jobs in this ordering.
  const pendingFlexible = placeable
    .filter((j) => j.pinnedTime === null && !seeded.has(j.id))
    .sort(compare);

  for (const job of pendingFlexible) {
    const insertion = bestInsertion(job.id, routes, ctx, maxJobsPerTeam);
    if (insertion) {
      routes[insertion.routeIndex].splice(insertion.position, 0, job.id);
      continue;
    }

    // Try once more ignoring the per-team cap: a slightly uneven day beats
    // telling the scheduler a job cannot be done at all.
    const relaxed = bestInsertion(job.id, routes, ctx, Number.POSITIVE_INFINITY);
    if (relaxed) {
      routes[relaxed.routeIndex].splice(relaxed.position, 0, job.id);
      continue;
    }

    overflow.push(job);
  }

  // Step 4: improvement.
  improve(routes, ctx, maxJobsPerTeam);

  // With capacity freed up by the improvement pass, retry the leftovers inside
  // their windows. This routinely rescues the last one or two jobs of a tight
  // Saturday, and it runs before any of them are stacked over.
  for (let i = overflow.length - 1; i >= 0; i -= 1) {
    const insertion = bestInsertion(overflow[i].id, routes, ctx, Number.POSITIVE_INFINITY);
    if (insertion) {
      routes[insertion.routeIndex].splice(insertion.position, 0, overflow[i].id);
      overflow.splice(i, 1);
    }
  }

  // Step 5: everything still left over goes on a team anyway, stacked past the
  // window it could not make. The cap does the sharing out, so one team does not
  // absorb the whole overflow just for being nearest the middle of the Cape.
  for (const job of overflow) {
    const insertion =
      bestInsertion(job.id, routes, ctx, maxJobsPerTeam, true) ??
      bestInsertion(job.id, routes, ctx, Number.POSITIVE_INFINITY, true);

    if (insertion) {
      routes[insertion.routeIndex].splice(insertion.position, 0, job.id);
    } else {
      // Only reachable with zero teams, which the caller has already ruled out.
      unplaced.push({
        jobId: job.id,
        reason: "There are no teams to put this job on.",
      });
    }
  }

  // A second improvement round, now that the stacked jobs are in — an overfull
  // day still deserves a sensible order. It can only shorten the driving; the
  // guard stops it trading a window or a lock for a mile.
  improve(routes, ctx, maxJobsPerTeam);

  let driveMinutes = 0;
  let lateStops = 0;
  for (const route of routes) {
    const evaluation = evaluateRoute(route, ctx);
    driveMinutes += evaluation.driveMinutes;
    lateStops += evaluation.stops.filter((stop) => stop.violation !== null).length;
  }

  return { routes, unplaced, driveMinutes, lateStops };
}

export function optimize(input: OptimizerInput): OptimizerResult {
  const { jobs, matrix, teamCount } = input;
  const ctx = buildContext(jobs, matrix);

  const unschedulable: { jobId: string; reason: string }[] = [];
  if (jobs.length === 0 || teamCount < 1) {
    return { routes: [], unschedulable, totalDriveMinutes: 0 };
  }

  // Every job goes on a team, including one whose own duration cannot fit its
  // own window — that is a fact about the booking, not something the routing can
  // fix, and the stop says so where the scheduler will read it.
  const placeable = jobs;

  const maxJobsPerTeam =
    input.maxJobsPerTeam ?? Math.max(1, Math.ceil(placeable.length / teamCount) + 1);

  // Run every ordering and keep the best. Since nothing is ever refused now, the
  // measure of a good day is how few stops end up outside their window; drive
  // time breaks the tie.
  let best: Attempt | null = null;
  for (const ordering of ORDERINGS) {
    const candidate = attempt(placeable, ctx, teamCount, maxJobsPerTeam, ordering.compare);
    if (
      !best ||
      candidate.lateStops < best.lateStops ||
      (candidate.lateStops === best.lateStops && candidate.driveMinutes < best.driveMinutes - 0.01)
    ) {
      best = candidate;
    }
  }

  const chosen = best!;
  unschedulable.push(...chosen.unplaced);

  // Step 6: report. Every stop outside its window is surfaced by name, on the
  // board and on the printed sheet.
  const built: OptimizedRoute[] = [];
  let totalDriveMinutes = 0;

  chosen.routes
    .filter((route) => route.length > 0)
    .forEach((route, position) => {
      const evaluation = evaluateRoute(route, ctx);
      totalDriveMinutes += evaluation.driveMinutes;
      built.push({ position, stops: evaluation.stops, driveMinutes: evaluation.driveMinutes });
    });

  for (const route of built) {
    for (const stop of route.stops) {
      if (stop.violation) unschedulable.push({ jobId: stop.jobId, reason: stop.violation });
    }
  }

  return { routes: built, unschedulable, totalDriveMinutes };
}
