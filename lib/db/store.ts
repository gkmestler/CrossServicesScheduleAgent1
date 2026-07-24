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
 * The storage contract.
 *
 * There are two implementations behind this: Postgres via Drizzle (production,
 * and local development once DATABASE_URL is set) and a JSON file store used
 * when DATABASE_URL is absent, so `npm run dev` works on a fresh clone with no
 * infrastructure at all. Both are exercised through this interface only.
 */
export interface Store {
  readonly kind: "postgres" | "file";

  /* Schedules */
  listSchedules(limit: number): Promise<Schedule[]>;
  getSchedule(id: string): Promise<Schedule | null>;
  createSchedule(input: Omit<Schedule, "id" | "createdAt">): Promise<Schedule>;
  updateSchedule(id: string, patch: Partial<Schedule>): Promise<void>;

  /* Houses and customers */
  getOrCreateHouse(input: {
    normalizedAddress: string;
    displayAddress: string;
    town: string;
  }): Promise<House>;
  updateHouse(id: string, patch: Partial<House>): Promise<void>;
  getHouses(ids: string[]): Promise<House[]>;
  getOrCreateCustomer(name: string, houseId: string): Promise<Customer>;
  updateCustomer(id: string, patch: Partial<Customer>): Promise<void>;

  /* Jobs */
  insertJobs(jobs: Job[]): Promise<void>;
  listJobs(scheduleId: string): Promise<Job[]>;
  getJob(id: string): Promise<Job | null>;
  updateJob(id: string, patch: Pick<Partial<Job>, "overrides" | "confirmed">): Promise<void>;

  /* Routes */
  listRoutes(scheduleId: string): Promise<Route[]>;
  replaceRoutes(scheduleId: string, routes: Omit<Route, "id" | "scheduleId">[]): Promise<Route[]>;
  updateRoute(id: string, patch: Partial<Pick<Route, "finalTeam" | "stops">>): Promise<void>;

  /* Learning */
  recordCorrections(rows: Omit<Correction, "id" | "createdAt">[]): Promise<void>;
  correctionsForCustomerNames(names: string[]): Promise<Correction[]>;
  recordAssignments(rows: Omit<Assignment, "id">[]): Promise<void>;
  assignmentsForHouses(houseIds: string[]): Promise<Assignment[]>;
  recordOverrides(rows: Omit<Override, "id" | "createdAt">[]): Promise<void>;
  recentOverrides(limit: number): Promise<Override[]>;
}

/** Short, sortable, collision-resistant enough for a single-user tool. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${time}${random}`;
}
