import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema (Supabase used purely as a Postgres host — no Supabase Auth,
 * no RLS, no supabase-js; all access is server-side through Drizzle over the
 * pooled Supavisor connection string).
 *
 * Access codes live here as ordinary text fields. They are never logged, never
 * put in error messages, and never included in the optimizer or team-suggestion
 * payloads. They travel only in parsing input/output and the export view.
 */

export const houses = pgTable(
  "houses",
  {
    id: text("id").primaryKey(),
    normalizedAddress: text("normalized_address").notNull(),
    displayAddress: text("display_address").notNull(),
    town: text("town").notNull(),
    lat: real("lat"),
    lng: real("lng"),
    /** Learned from history; the optimizer falls back to 90 minutes. */
    durationEstimateMinutes: integer("duration_estimate_minutes"),
    geoSource: text("geo_source"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("houses_normalized_address_key").on(table.normalizedAddress)],
);

export const customers = pgTable(
  "customers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    houseId: text("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    /** Accumulated access info and instructions that recur for this customer. */
    standingNotes: text("standing_notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("customers_name_house_key").on(table.name, table.houseId)],
);

export const schedules = pgTable("schedules", {
  id: text("id").primaryKey(),
  /** ISO date. Saturdays only in v1. */
  date: text("date").notNull(),
  teamCount: integer("team_count").notNull().default(8),
  /** "draft" | "final" */
  status: text("status").notNull().default("draft"),
  parseSource: text("parse_source").notNull().default("heuristic"),
  parseNote: text("parse_note"),
  distanceSource: text("distance_source"),
  totalDriveMinutes: real("total_drive_minutes"),
  unschedulable: jsonb("unschedulable").notNull().default([]),
  /** Cached drive-time matrix from the last build; see Schedule.matrix. */
  matrix: jsonb("matrix"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
});

export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  scheduleId: text("schedule_id")
    .notNull()
    .references(() => schedules.id, { onDelete: "cascade" }),
  houseId: text("house_id")
    .notNull()
    .references(() => houses.id, { onDelete: "cascade" }),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  rawRow: jsonb("raw_row").notNull(),
  parsed: jsonb("parsed").notNull(),
  /** Scheduler corrections, applied over `parsed` to produce the effective job. */
  overrides: jsonb("overrides").notNull().default({}),
  confidence: text("confidence").notNull().default("high"),
  windowStart: text("window_start").notNull(),
  windowEnd: text("window_end").notNull(),
  pinnedTime: text("pinned_time"),
  confirmed: boolean("confirmed").notNull().default(false),
  position: integer("position").notNull().default(0),
});

export const routes = pgTable("routes", {
  id: text("id").primaryKey(),
  scheduleId: text("schedule_id")
    .notNull()
    .references(() => schedules.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  /** Claude's suggestion. Advisory only — routing never changes because of it. */
  suggestedTeam: integer("suggested_team"),
  suggestionRationale: text("suggestion_rationale"),
  finalTeam: integer("final_team"),
});

export const routeStops = pgTable("route_stops", {
  id: text("id").primaryKey(),
  routeId: text("route_id")
    .notNull()
    .references(() => routes.id, { onDelete: "cascade" }),
  jobId: text("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  estArrival: text("est_arrival").notNull(),
  estFinish: text("est_finish").notNull(),
  wasMovedByUser: boolean("was_moved_by_user").notNull().default(false),
});

export const corrections = pgTable("corrections", {
  id: text("id").primaryKey(),
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id, { onDelete: "cascade" }),
  customerName: text("customer_name").notNull(),
  field: text("field").notNull(),
  aiValue: text("ai_value"),
  userValue: text("user_value"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Which team cleaned which house on which Saturday. Powers team suggestions. */
export const assignments = pgTable("assignments", {
  id: text("id").primaryKey(),
  scheduleId: text("schedule_id")
    .notNull()
    .references(() => schedules.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  houseId: text("house_id")
    .notNull()
    .references(() => houses.id, { onDelete: "cascade" }),
  team: integer("team").notNull(),
});

/** Manual changes relative to what the optimizer proposed. */
export const overrides = pgTable("overrides", {
  id: text("id").primaryKey(),
  scheduleId: text("schedule_id")
    .notNull()
    .references(() => schedules.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  kind: text("kind").notNull(),
  description: text("description").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
