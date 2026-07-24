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
  /** Minutes driven to reach this stop from the previous one. 0 for the first. */
  driveMinutes: number;
  /** Set when this stop finishes after its window closes, or misses a pin. */
  violation: string | null;
};

export type RouteEvaluation = {
  stops: EvaluatedStop[];
  driveMinutes: number;
  feasible: boolean;
};

export type OptimizedRoute = {
  position: number;
  stops: EvaluatedStop[];
  driveMinutes: number;
};

export type OptimizerResult = {
  routes: OptimizedRoute[];
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
 * A team has no depot — the day starts when they reach their first house. Each
 * subsequent arrival is the later of "when the window opens" and "when they can
 * physically get there". A pinned job is arrived at exactly on its time, waiting
 * if necessary; being unable to reach it by then is the violation.
 *
 * This is also what the board calls client-side on every drop, which is why it
 * reports violations instead of throwing.
 */
export function evaluateRoute(order: string[], ctx: EvalContext): RouteEvaluation {
  const stops: EvaluatedStop[] = [];
  let driveTotal = 0;
  let previousFinish: number | null = null;
  let previousId: string | null = null;
  let feasible = true;

  for (const jobId of order) {
    const job = ctx.jobs.get(jobId);
    if (!job) continue;

    const drive = previousId === null ? 0 : travel(ctx, previousId, jobId);
    driveTotal += drive;

    const earliest =
      previousFinish === null ? job.windowStart : Math.max(job.windowStart, previousFinish + drive);

    let arrival: number;
    let violation: string | null = null;

    if (job.pinnedTime !== null) {
      arrival = job.pinnedTime;
      if (earliest > job.pinnedTime) {
        violation = `Cannot reach this pinned ${formatClock(job.pinnedTime)} job before ${formatClock(earliest)}.`;
      }
      if (job.pinnedTime + job.durationMinutes > job.windowEnd) {
        violation = `Pinned at ${formatClock(job.pinnedTime)}, which finishes after the ${formatClock(job.windowEnd)} window close.`;
      }
    } else {
      arrival = earliest;
      if (arrival + job.durationMinutes > job.windowEnd) {
        violation = `Finishes at ${formatClock(arrival + job.durationMinutes)}, after the ${formatClock(job.windowEnd)} window close.`;
      }
    }

    if (violation) feasible = false;

    const finish = arrival + job.durationMinutes;
    stops.push({ jobId, arrival, finish, driveMinutes: drive, violation });

    previousFinish = finish;
    previousId = jobId;
  }

  return { stops, driveMinutes: driveTotal, feasible };
}

function formatClock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes) % 60;
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12}${suffix}` : `${h12}:${String(m).padStart(2, "0")}${suffix}`;
}

function isFeasible(order: string[], ctx: EvalContext): boolean {
  return evaluateRoute(order, ctx).feasible;
}

function driveOf(order: string[], ctx: EvalContext): number {
  return evaluateRoute(order, ctx).driveMinutes;
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

function bestInsertion(
  jobId: string,
  routes: string[][],
  ctx: EvalContext,
  maxJobsPerTeam: number,
): InsertionCandidate | null {
  let best: InsertionCandidate | null = null;

  for (let r = 0; r < routes.length; r += 1) {
    const route = routes[r];
    if (route.length >= maxJobsPerTeam) continue;

    const baseDrive = driveOf(route, ctx);

    for (let position = 0; position <= route.length; position += 1) {
      const candidate = [...route.slice(0, position), jobId, ...route.slice(position)];
      const evaluation = evaluateRoute(candidate, ctx);
      if (!evaluation.feasible) continue;

      const cost = evaluation.driveMinutes - baseDrive;
      if (!best || cost < best.cost) best = { routeIndex: r, position, cost };
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
  let currentDrive = driveOf(current, ctx);
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
        const evaluation = evaluateRoute(candidate, ctx);
        // Time windows make most reversals infeasible; only keep the ones that
        // survive both checks.
        if (!evaluation.feasible) continue;
        if (evaluation.driveMinutes < currentDrive - 0.01) {
          current = candidate;
          currentDrive = evaluation.driveMinutes;
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
    for (let stopIndex = 0; stopIndex < routes[from].length; stopIndex += 1) {
      const jobId = routes[from][stopIndex];
      const without = [...routes[from].slice(0, stopIndex), ...routes[from].slice(stopIndex + 1)];
      if (!isFeasible(without, ctx)) continue;

      const savedHere = driveOf(routes[from], ctx) - driveOf(without, ctx);

      for (let to = 0; to < routes.length; to += 1) {
        if (to === from) continue;
        if (routes[to].length >= maxJobsPerTeam) continue;

        const baseDrive = driveOf(routes[to], ctx);
        for (let position = 0; position <= routes[to].length; position += 1) {
          const candidate = [
            ...routes[to].slice(0, position),
            jobId,
            ...routes[to].slice(position),
          ];
          const evaluation = evaluateRoute(candidate, ctx);
          if (!evaluation.feasible) continue;

          const addedThere = evaluation.driveMinutes - baseDrive;
          if (addedThere < savedHere - 0.01) {
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
      const baseDrive = driveOf(routes[a], ctx) + driveOf(routes[b], ctx);

      for (let i = 0; i < routes[a].length; i += 1) {
        for (let j = 0; j < routes[b].length; j += 1) {
          const nextA = [...routes[a]];
          const nextB = [...routes[b]];
          [nextA[i], nextB[j]] = [nextB[j], nextA[i]];

          const evalA = evaluateRoute(nextA, ctx);
          const evalB = evaluateRoute(nextB, ctx);
          if (!evalA.feasible || !evalB.feasible) continue;

          if (evalA.driveMinutes + evalB.driveMinutes < baseDrive - 0.01) {
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
};

function attempt(
  placeable: OptimizerJob[],
  ctx: EvalContext,
  teamCount: number,
  maxJobsPerTeam: number,
  compare: (a: OptimizerJob, b: OptimizerJob) => number,
): Attempt {
  const unplaced: { jobId: string; reason: string }[] = [];

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
      unplaced.push({
        jobId: job.id,
        reason: `No team can take this ${formatClock(job.pinnedTime ?? 0)} time lock without pushing another job past its window.`,
      });
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

    unplaced.push({
      jobId: job.id,
      reason: `No team can fit this job inside its ${formatClock(job.windowStart)}-${formatClock(job.windowEnd)} window.`,
    });
  }

  // Step 4: improvement. 2-opt within routes, then relocations and swaps
  // between them, until nothing improves or the budget runs out.
  const MAX_PASSES = 40;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    for (let r = 0; r < routes.length; r += 1) {
      routes[r] = twoOpt(routes[r], ctx);
    }
    const moved = relocateBetweenRoutes(routes, ctx, maxJobsPerTeam);
    const swapped = moved ? false : swapBetweenRoutes(routes, ctx);
    if (!moved && !swapped) break;
  }

  // With capacity freed up by the improvement pass, retry anything that would
  // otherwise be reported unschedulable. This routinely rescues the last one or
  // two jobs of a tight Saturday.
  for (let i = unplaced.length - 1; i >= 0; i -= 1) {
    const insertion = bestInsertion(unplaced[i].jobId, routes, ctx, Number.POSITIVE_INFINITY);
    if (insertion) {
      routes[insertion.routeIndex].splice(insertion.position, 0, unplaced[i].jobId);
      unplaced.splice(i, 1);
    }
  }

  const driveMinutes = routes.reduce((sum, route) => sum + driveOf(route, ctx), 0);
  return { routes, unplaced, driveMinutes };
}

export function optimize(input: OptimizerInput): OptimizerResult {
  const { jobs, matrix, teamCount } = input;
  const ctx = buildContext(jobs, matrix);

  const unschedulable: { jobId: string; reason: string }[] = [];
  if (jobs.length === 0 || teamCount < 1) {
    return { routes: [], unschedulable, totalDriveMinutes: 0 };
  }

  // A job whose own duration does not fit its own window can never be placed,
  // whatever the routing does. Say so plainly rather than squeezing it in.
  const placeable: OptimizerJob[] = [];
  for (const job of jobs) {
    if (job.windowStart + job.durationMinutes > job.windowEnd) {
      unschedulable.push({
        jobId: job.id,
        reason: `The ${Math.round(job.durationMinutes)}-minute clean does not fit inside the ${formatClock(job.windowStart)}-${formatClock(job.windowEnd)} window.`,
      });
      continue;
    }
    if (
      job.pinnedTime !== null &&
      (job.pinnedTime < job.windowStart || job.pinnedTime + job.durationMinutes > job.windowEnd)
    ) {
      unschedulable.push({
        jobId: job.id,
        reason: `The ${formatClock(job.pinnedTime)} time lock falls outside the ${formatClock(job.windowStart)}-${formatClock(job.windowEnd)} window.`,
      });
      continue;
    }
    placeable.push(job);
  }

  const maxJobsPerTeam =
    input.maxJobsPerTeam ?? Math.max(1, Math.ceil(placeable.length / teamCount) + 1);

  // Run every ordering and keep the best. Placing every job matters far more
  // than shaving drive minutes, so that is the primary key.
  let best: Attempt | null = null;
  for (const ordering of ORDERINGS) {
    const candidate = attempt(placeable, ctx, teamCount, maxJobsPerTeam, ordering.compare);
    if (
      !best ||
      candidate.unplaced.length < best.unplaced.length ||
      (candidate.unplaced.length === best.unplaced.length &&
        candidate.driveMinutes < best.driveMinutes - 0.01)
    ) {
      best = candidate;
    }
  }

  const chosen = best!;
  unschedulable.push(...chosen.unplaced);

  // Step 5: validate. Anything still violating its window after all of that is
  // surfaced rather than silently squeezed in.
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
