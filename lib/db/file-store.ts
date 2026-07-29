import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { newId, type Store } from "@/lib/db/store";
import type {
  Assignment,
  Correction,
  Customer,
  House,
  Job,
  Override,
  Route,
  Schedule,
} from "@/lib/types";

/**
 * A JSON-file store used when DATABASE_URL is not set.
 *
 * This exists so `npm run dev` works on a fresh clone with no Supabase project,
 * no migrations and no network — the scheduler can upload a file and see the
 * whole flow immediately. It is not the production path: Postgres is (see
 * pg-store.ts). Writes are serialized through a promise chain, which is fine for
 * one user on one machine and would not be for anything else.
 */

type Snapshot = {
  schedules: Schedule[];
  houses: House[];
  customers: Customer[];
  jobs: Job[];
  routes: Route[];
  corrections: Correction[];
  assignments: Assignment[];
  overrides: Override[];
};

const EMPTY: Snapshot = {
  schedules: [],
  houses: [],
  customers: [],
  jobs: [],
  routes: [],
  corrections: [],
  assignments: [],
  overrides: [],
};

const DATA_DIR = path.join(process.cwd(), ".data");
const DATA_FILE = path.join(DATA_DIR, "scheduler.json");

export class FileStore implements Store {
  readonly kind = "file" as const;

  private cache: Snapshot | null = null;
  /** Serializes writes; concurrent route handlers would otherwise clobber. */
  private queue: Promise<unknown> = Promise.resolve();

  private async load(): Promise<Snapshot> {
    if (this.cache) return this.cache;
    try {
      const text = await readFile(DATA_FILE, "utf8");
      this.cache = { ...EMPTY, ...(JSON.parse(text) as Partial<Snapshot>) };
    } catch {
      this.cache = structuredClone(EMPTY);
    }
    return this.cache;
  }

  /** Read, mutate, persist — one at a time. */
  private mutate<T>(fn: (data: Snapshot) => T | Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const data = await this.load();
      const result = await fn(data);
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
      return result;
    });
    // Keep the chain alive even if one operation rejects.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /* ---------------------------------------------------------------- Schedules */

  async listSchedules(limit: number): Promise<Schedule[]> {
    const data = await this.load();
    return [...data.schedules]
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getSchedule(id: string): Promise<Schedule | null> {
    const data = await this.load();
    return data.schedules.find((s) => s.id === id) ?? null;
  }

  async createSchedule(input: Omit<Schedule, "id" | "createdAt">): Promise<Schedule> {
    return this.mutate((data) => {
      const schedule: Schedule = { ...input, id: newId("sch"), createdAt: new Date().toISOString() };
      data.schedules.push(schedule);
      return schedule;
    });
  }

  async updateSchedule(id: string, patch: Partial<Schedule>): Promise<void> {
    await this.mutate((data) => {
      const schedule = data.schedules.find((s) => s.id === id);
      if (schedule) Object.assign(schedule, patch);
    });
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.mutate((data) => {
      // Postgres does this with cascades; here the same set is removed by hand.
      // Houses and customers are shared across Saturdays and stay put, which is
      // what the Postgres foreign keys do too.
      data.schedules = data.schedules.filter((s) => s.id !== id);
      data.jobs = data.jobs.filter((j) => j.scheduleId !== id);
      data.routes = data.routes.filter((r) => r.scheduleId !== id);
      data.assignments = data.assignments.filter((a) => a.scheduleId !== id);
      data.overrides = data.overrides.filter((o) => o.scheduleId !== id);
    });
  }

  /* ------------------------------------------------------ Houses and customers */

  async getOrCreateHouse(input: {
    normalizedAddress: string;
    displayAddress: string;
    town: string;
  }): Promise<House> {
    return this.mutate((data) => {
      const existing = data.houses.find((h) => h.normalizedAddress === input.normalizedAddress);
      if (existing) return existing;
      const house: House = {
        id: newId("hse"),
        normalizedAddress: input.normalizedAddress,
        displayAddress: input.displayAddress,
        town: input.town,
        lat: null,
        lng: null,
        durationEstimateMinutes: null,
        geoSource: null,
      };
      data.houses.push(house);
      return house;
    });
  }

  async updateHouse(id: string, patch: Partial<House>): Promise<void> {
    await this.mutate((data) => {
      const house = data.houses.find((h) => h.id === id);
      if (house) Object.assign(house, patch);
    });
  }

  async getHouses(ids: string[]): Promise<House[]> {
    const data = await this.load();
    const wanted = new Set(ids);
    return data.houses.filter((h) => wanted.has(h.id));
  }

  async getOrCreateCustomer(name: string, houseId: string): Promise<Customer> {
    return this.mutate((data) => {
      const existing = data.customers.find((c) => c.name === name && c.houseId === houseId);
      if (existing) return existing;
      const customer: Customer = { id: newId("cst"), name, houseId, standingNotes: null };
      data.customers.push(customer);
      return customer;
    });
  }

  async updateCustomer(id: string, patch: Partial<Customer>): Promise<void> {
    await this.mutate((data) => {
      const customer = data.customers.find((c) => c.id === id);
      if (customer) Object.assign(customer, patch);
    });
  }

  /* --------------------------------------------------------------------- Jobs */

  async insertJobs(jobs: Job[]): Promise<void> {
    await this.mutate((data) => {
      data.jobs.push(...jobs);
    });
  }

  async listJobs(scheduleId: string): Promise<Job[]> {
    const data = await this.load();
    return data.jobs.filter((j) => j.scheduleId === scheduleId);
  }

  async getJob(id: string): Promise<Job | null> {
    const data = await this.load();
    return data.jobs.find((j) => j.id === id) ?? null;
  }

  async updateJob(
    id: string,
    patch: Pick<Partial<Job>, "overrides" | "confirmed">,
  ): Promise<void> {
    await this.mutate((data) => {
      const job = data.jobs.find((j) => j.id === id);
      if (job) Object.assign(job, patch);
    });
  }

  async setJobsConfirmed(scheduleId: string, confirmed: boolean): Promise<void> {
    await this.mutate((data) => {
      for (const job of data.jobs) {
        if (job.scheduleId === scheduleId) job.confirmed = confirmed;
      }
    });
  }

  /* ------------------------------------------------------------------- Routes */

  async listRoutes(scheduleId: string): Promise<Route[]> {
    const data = await this.load();
    return data.routes
      .filter((r) => r.scheduleId === scheduleId)
      .sort((a, b) => a.position - b.position);
  }

  async replaceRoutes(
    scheduleId: string,
    routes: Omit<Route, "id" | "scheduleId">[],
  ): Promise<Route[]> {
    return this.mutate((data) => {
      data.routes = data.routes.filter((r) => r.scheduleId !== scheduleId);
      const created = routes.map((route) => ({ ...route, id: newId("rte"), scheduleId }));
      data.routes.push(...created);
      return created;
    });
  }

  async updateRoute(
    id: string,
    patch: Partial<Pick<Route, "finalTeam" | "stops">>,
  ): Promise<void> {
    await this.mutate((data) => {
      const route = data.routes.find((r) => r.id === id);
      if (route) Object.assign(route, patch);
    });
  }

  /* ----------------------------------------------------------------- Learning */

  async recordCorrections(rows: Omit<Correction, "id" | "createdAt">[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutate((data) => {
      const now = new Date().toISOString();
      for (const row of rows) {
        // One correction per customer+field: the newest is what to follow.
        data.corrections = data.corrections.filter(
          (c) => !(c.customerId === row.customerId && c.field === row.field),
        );
        data.corrections.push({ ...row, id: newId("cor"), createdAt: now });
      }
    });
  }

  async correctionsForCustomerNames(names: string[]): Promise<Correction[]> {
    const data = await this.load();
    const wanted = new Set(names.map((n) => n.trim().toLowerCase()));
    return data.corrections.filter((c) => wanted.has(c.customerName.trim().toLowerCase()));
  }

  async recordAssignments(rows: Omit<Assignment, "id">[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutate((data) => {
      const scheduleIds = new Set(rows.map((r) => r.scheduleId));
      // Re-finalizing replaces that schedule's assignments rather than doubling.
      data.assignments = data.assignments.filter((a) => !scheduleIds.has(a.scheduleId));
      data.assignments.push(...rows.map((row) => ({ ...row, id: newId("asg") })));
    });
  }

  async assignmentsForHouses(houseIds: string[]): Promise<Assignment[]> {
    const data = await this.load();
    const wanted = new Set(houseIds);
    return data.assignments
      .filter((a) => wanted.has(a.houseId))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  async recordOverrides(rows: Omit<Override, "id" | "createdAt">[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutate((data) => {
      const now = new Date().toISOString();
      data.overrides.push(...rows.map((row) => ({ ...row, id: newId("ovr"), createdAt: now })));
    });
  }

  async clearScheduleHistory(scheduleId: string): Promise<void> {
    await this.mutate((data) => {
      data.assignments = data.assignments.filter((a) => a.scheduleId !== scheduleId);
      data.overrides = data.overrides.filter((o) => o.scheduleId !== scheduleId);
    });
  }

  async recentOverrides(limit: number): Promise<Override[]> {
    const data = await this.load();
    return [...data.overrides]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
}
