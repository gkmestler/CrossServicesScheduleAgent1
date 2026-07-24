import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as t from "@/lib/db/schema";
import { newId, type Store } from "@/lib/db/store";
import type {
  Assignment,
  Correction,
  Customer,
  House,
  Job,
  Override,
  ParsedJob,
  RawRow,
  Route,
  RouteStop,
  Schedule,
} from "@/lib/types";

/**
 * Postgres via Supabase, used purely as a Postgres host.
 *
 * Connects with the pooled Supavisor connection string in transaction mode,
 * because Vercel serverless functions need pooling. Transaction mode does not
 * support prepared statements, hence `prepare: false`.
 */

let db: PostgresJsDatabase<typeof t> | null = null;

function getDb(): PostgresJsDatabase<typeof t> {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const client = postgres(url, { prepare: false, max: 1 });
    db = drizzle(client, { schema: t });
  }
  return db;
}

type ScheduleRow = typeof t.schedules.$inferSelect;
type JobRow = typeof t.jobs.$inferSelect;

function toSchedule(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    date: row.date,
    teamCount: row.teamCount,
    status: row.status as Schedule["status"],
    createdAt: row.createdAt.toISOString(),
    finalizedAt: row.finalizedAt ? row.finalizedAt.toISOString() : null,
    parseSource: row.parseSource as Schedule["parseSource"],
    parseNote: row.parseNote,
    distanceSource: row.distanceSource as Schedule["distanceSource"],
    totalDriveMinutes: row.totalDriveMinutes,
    unschedulable: (row.unschedulable ?? []) as Schedule["unschedulable"],
    matrix: (row.matrix ?? null) as Schedule["matrix"],
  };
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    houseId: row.houseId,
    customerId: row.customerId,
    raw: row.rawRow as RawRow,
    parsed: row.parsed as ParsedJob,
    overrides: (row.overrides ?? {}) as Partial<ParsedJob>,
    confirmed: row.confirmed,
  };
}

export class PostgresStore implements Store {
  readonly kind = "postgres" as const;

  /* ---------------------------------------------------------------- Schedules */

  async listSchedules(limit: number): Promise<Schedule[]> {
    const rows = await getDb()
      .select()
      .from(t.schedules)
      .orderBy(desc(t.schedules.date), desc(t.schedules.createdAt))
      .limit(limit);
    return rows.map(toSchedule);
  }

  async getSchedule(id: string): Promise<Schedule | null> {
    const rows = await getDb().select().from(t.schedules).where(eq(t.schedules.id, id)).limit(1);
    return rows[0] ? toSchedule(rows[0]) : null;
  }

  async createSchedule(input: Omit<Schedule, "id" | "createdAt">): Promise<Schedule> {
    const id = newId("sch");
    const rows = await getDb()
      .insert(t.schedules)
      .values({
        id,
        date: input.date,
        teamCount: input.teamCount,
        status: input.status,
        parseSource: input.parseSource,
        parseNote: input.parseNote,
        distanceSource: input.distanceSource,
        totalDriveMinutes: input.totalDriveMinutes,
        unschedulable: input.unschedulable,
        matrix: input.matrix,
        finalizedAt: input.finalizedAt ? new Date(input.finalizedAt) : null,
      })
      .returning();
    return toSchedule(rows[0]);
  }

  async updateSchedule(id: string, patch: Partial<Schedule>): Promise<void> {
    const values: Partial<typeof t.schedules.$inferInsert> = {};
    if (patch.date !== undefined) values.date = patch.date;
    if (patch.teamCount !== undefined) values.teamCount = patch.teamCount;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.parseSource !== undefined) values.parseSource = patch.parseSource;
    if (patch.parseNote !== undefined) values.parseNote = patch.parseNote;
    if (patch.distanceSource !== undefined) values.distanceSource = patch.distanceSource;
    if (patch.totalDriveMinutes !== undefined) values.totalDriveMinutes = patch.totalDriveMinutes;
    if (patch.unschedulable !== undefined) values.unschedulable = patch.unschedulable;
    if (patch.matrix !== undefined) values.matrix = patch.matrix;
    if (patch.finalizedAt !== undefined) {
      values.finalizedAt = patch.finalizedAt ? new Date(patch.finalizedAt) : null;
    }
    if (Object.keys(values).length === 0) return;
    await getDb().update(t.schedules).set(values).where(eq(t.schedules.id, id));
  }

  /* ------------------------------------------------------ Houses and customers */

  async getOrCreateHouse(input: {
    normalizedAddress: string;
    displayAddress: string;
    town: string;
  }): Promise<House> {
    const database = getDb();
    // Most customers recur weekly, so this is nearly always a cache hit and the
    // geocode below it never runs.
    const inserted = await database
      .insert(t.houses)
      .values({
        id: newId("hse"),
        normalizedAddress: input.normalizedAddress,
        displayAddress: input.displayAddress,
        town: input.town,
      })
      .onConflictDoNothing({ target: t.houses.normalizedAddress })
      .returning();

    if (inserted[0]) return this.toHouse(inserted[0]);

    const existing = await database
      .select()
      .from(t.houses)
      .where(eq(t.houses.normalizedAddress, input.normalizedAddress))
      .limit(1);
    return this.toHouse(existing[0]);
  }

  private toHouse(row: typeof t.houses.$inferSelect): House {
    return {
      id: row.id,
      normalizedAddress: row.normalizedAddress,
      displayAddress: row.displayAddress,
      town: row.town,
      lat: row.lat,
      lng: row.lng,
      durationEstimateMinutes: row.durationEstimateMinutes,
      geoSource: row.geoSource as House["geoSource"],
    };
  }

  async updateHouse(id: string, patch: Partial<House>): Promise<void> {
    const values: Partial<typeof t.houses.$inferInsert> = {};
    if (patch.lat !== undefined) values.lat = patch.lat;
    if (patch.lng !== undefined) values.lng = patch.lng;
    if (patch.town !== undefined) values.town = patch.town;
    if (patch.displayAddress !== undefined) values.displayAddress = patch.displayAddress;
    if (patch.geoSource !== undefined) values.geoSource = patch.geoSource;
    if (patch.durationEstimateMinutes !== undefined) {
      values.durationEstimateMinutes = patch.durationEstimateMinutes;
    }
    if (Object.keys(values).length === 0) return;
    await getDb().update(t.houses).set(values).where(eq(t.houses.id, id));
  }

  async getHouses(ids: string[]): Promise<House[]> {
    if (ids.length === 0) return [];
    const rows = await getDb().select().from(t.houses).where(inArray(t.houses.id, ids));
    return rows.map((row) => this.toHouse(row));
  }

  async getOrCreateCustomer(name: string, houseId: string): Promise<Customer> {
    const database = getDb();
    const inserted = await database
      .insert(t.customers)
      .values({ id: newId("cst"), name, houseId })
      .onConflictDoNothing({ target: [t.customers.name, t.customers.houseId] })
      .returning();

    const row =
      inserted[0] ??
      (
        await database
          .select()
          .from(t.customers)
          .where(and(eq(t.customers.name, name), eq(t.customers.houseId, houseId)))
          .limit(1)
      )[0];

    return { id: row.id, name: row.name, houseId: row.houseId, standingNotes: row.standingNotes };
  }

  async updateCustomer(id: string, patch: Partial<Customer>): Promise<void> {
    if (patch.standingNotes === undefined) return;
    await getDb()
      .update(t.customers)
      .set({ standingNotes: patch.standingNotes })
      .where(eq(t.customers.id, id));
  }

  /* --------------------------------------------------------------------- Jobs */

  async insertJobs(jobs: Job[]): Promise<void> {
    if (jobs.length === 0) return;
    await getDb()
      .insert(t.jobs)
      .values(
        jobs.map((job, index) => ({
          id: job.id,
          scheduleId: job.scheduleId,
          houseId: job.houseId,
          customerId: job.customerId,
          rawRow: job.raw,
          parsed: job.parsed,
          overrides: job.overrides,
          confidence: job.parsed.confidence,
          windowStart: job.parsed.window_start,
          windowEnd: job.parsed.window_end,
          pinnedTime: job.parsed.pinned_time,
          confirmed: job.confirmed,
          position: index,
        })),
      );
  }

  async listJobs(scheduleId: string): Promise<Job[]> {
    const rows = await getDb()
      .select()
      .from(t.jobs)
      .where(eq(t.jobs.scheduleId, scheduleId))
      .orderBy(t.jobs.position);
    return rows.map(toJob);
  }

  async getJob(id: string): Promise<Job | null> {
    const rows = await getDb().select().from(t.jobs).where(eq(t.jobs.id, id)).limit(1);
    return rows[0] ? toJob(rows[0]) : null;
  }

  async updateJob(
    id: string,
    patch: Pick<Partial<Job>, "overrides" | "confirmed">,
  ): Promise<void> {
    const values: Partial<typeof t.jobs.$inferInsert> = {};
    if (patch.confirmed !== undefined) values.confirmed = patch.confirmed;
    if (patch.overrides !== undefined) {
      values.overrides = patch.overrides;
      // Mirror the timing fields into columns so the board and any future SQL
      // reporting can filter on them without digging through jsonb.
      if (patch.overrides.window_start !== undefined) {
        values.windowStart = patch.overrides.window_start;
      }
      if (patch.overrides.window_end !== undefined) {
        values.windowEnd = patch.overrides.window_end;
      }
      if (patch.overrides.pinned_time !== undefined) {
        values.pinnedTime = patch.overrides.pinned_time;
      }
    }
    if (Object.keys(values).length === 0) return;
    await getDb().update(t.jobs).set(values).where(eq(t.jobs.id, id));
  }

  /* ------------------------------------------------------------------- Routes */

  async listRoutes(scheduleId: string): Promise<Route[]> {
    const database = getDb();
    const routeRows = await database
      .select()
      .from(t.routes)
      .where(eq(t.routes.scheduleId, scheduleId))
      .orderBy(t.routes.position);

    if (routeRows.length === 0) return [];

    const stopRows = await database
      .select()
      .from(t.routeStops)
      .where(
        inArray(
          t.routeStops.routeId,
          routeRows.map((r) => r.id),
        ),
      )
      .orderBy(t.routeStops.position);

    const stopsByRoute = new Map<string, RouteStop[]>();
    for (const stop of stopRows) {
      const list = stopsByRoute.get(stop.routeId) ?? [];
      list.push({
        jobId: stop.jobId,
        position: stop.position,
        estArrival: stop.estArrival,
        estFinish: stop.estFinish,
        wasMovedByUser: stop.wasMovedByUser,
      });
      stopsByRoute.set(stop.routeId, list);
    }

    return routeRows.map((row) => ({
      id: row.id,
      scheduleId: row.scheduleId,
      position: row.position,
      suggestedTeam: row.suggestedTeam,
      suggestionRationale: row.suggestionRationale,
      finalTeam: row.finalTeam,
      stops: stopsByRoute.get(row.id) ?? [],
    }));
  }

  async replaceRoutes(
    scheduleId: string,
    routes: Omit<Route, "id" | "scheduleId">[],
  ): Promise<Route[]> {
    const database = getDb();
    return database.transaction(async (tx) => {
      // route_stops cascades from routes, so this clears both.
      await tx.delete(t.routes).where(eq(t.routes.scheduleId, scheduleId));
      if (routes.length === 0) return [];

      const created = routes.map((route) => ({ ...route, id: newId("rte"), scheduleId }));

      await tx.insert(t.routes).values(
        created.map((route) => ({
          id: route.id,
          scheduleId,
          position: route.position,
          suggestedTeam: route.suggestedTeam,
          suggestionRationale: route.suggestionRationale,
          finalTeam: route.finalTeam,
        })),
      );

      const stops = created.flatMap((route) =>
        route.stops.map((stop) => ({
          id: newId("stp"),
          routeId: route.id,
          jobId: stop.jobId,
          position: stop.position,
          estArrival: stop.estArrival,
          estFinish: stop.estFinish,
          wasMovedByUser: stop.wasMovedByUser,
        })),
      );
      if (stops.length > 0) await tx.insert(t.routeStops).values(stops);

      return created;
    });
  }

  async updateRoute(
    id: string,
    patch: Partial<Pick<Route, "finalTeam" | "stops">>,
  ): Promise<void> {
    const database = getDb();
    await database.transaction(async (tx) => {
      if (patch.finalTeam !== undefined) {
        await tx.update(t.routes).set({ finalTeam: patch.finalTeam }).where(eq(t.routes.id, id));
      }
      if (patch.stops !== undefined) {
        await tx.delete(t.routeStops).where(eq(t.routeStops.routeId, id));
        if (patch.stops.length > 0) {
          await tx.insert(t.routeStops).values(
            patch.stops.map((stop) => ({
              id: newId("stp"),
              routeId: id,
              jobId: stop.jobId,
              position: stop.position,
              estArrival: stop.estArrival,
              estFinish: stop.estFinish,
              wasMovedByUser: stop.wasMovedByUser,
            })),
          );
        }
      }
    });
  }

  /* ----------------------------------------------------------------- Learning */

  async recordCorrections(rows: Omit<Correction, "id" | "createdAt">[]): Promise<void> {
    if (rows.length === 0) return;
    const database = getDb();
    await database.transaction(async (tx) => {
      for (const row of rows) {
        // One correction per customer+field: the newest is what to follow.
        await tx
          .delete(t.corrections)
          .where(
            and(eq(t.corrections.customerId, row.customerId), eq(t.corrections.field, row.field)),
          );
        await tx.insert(t.corrections).values({
          id: newId("cor"),
          customerId: row.customerId,
          customerName: row.customerName,
          field: row.field,
          aiValue: row.aiValue,
          userValue: row.userValue,
        });
      }
    });
  }

  async correctionsForCustomerNames(names: string[]): Promise<Correction[]> {
    if (names.length === 0) return [];
    const lowered = names.map((n) => n.trim().toLowerCase());
    const rows = await getDb()
      .select()
      .from(t.corrections)
      .where(inArray(sql`lower(trim(${t.corrections.customerName}))`, lowered));

    return rows.map((row) => ({
      id: row.id,
      customerId: row.customerId,
      customerName: row.customerName,
      field: row.field as Correction["field"],
      aiValue: row.aiValue,
      userValue: row.userValue,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async recordAssignments(rows: Omit<Assignment, "id">[]): Promise<void> {
    if (rows.length === 0) return;
    const database = getDb();
    const scheduleIds = [...new Set(rows.map((r) => r.scheduleId))];
    await database.transaction(async (tx) => {
      // Re-finalizing replaces that schedule's assignments rather than doubling.
      await tx.delete(t.assignments).where(inArray(t.assignments.scheduleId, scheduleIds));
      await tx.insert(t.assignments).values(rows.map((row) => ({ ...row, id: newId("asg") })));
    });
  }

  async assignmentsForHouses(houseIds: string[]): Promise<Assignment[]> {
    if (houseIds.length === 0) return [];
    const rows = await getDb()
      .select()
      .from(t.assignments)
      .where(inArray(t.assignments.houseId, houseIds))
      .orderBy(desc(t.assignments.date));
    return rows;
  }

  async recordOverrides(rows: Omit<Override, "id" | "createdAt">[]): Promise<void> {
    if (rows.length === 0) return;
    await getDb()
      .insert(t.overrides)
      .values(rows.map((row) => ({ ...row, id: newId("ovr") })));
  }

  async recentOverrides(limit: number): Promise<Override[]> {
    const rows = await getDb()
      .select()
      .from(t.overrides)
      .orderBy(desc(t.overrides.createdAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      scheduleId: row.scheduleId,
      date: row.date,
      kind: row.kind as Override["kind"],
      description: row.description,
      createdAt: row.createdAt.toISOString(),
    }));
  }
}
