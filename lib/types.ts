/**
 * Domain types shared by the server routes, the optimizer and the client.
 *
 * Times are "HH:MM" 24-hour strings throughout. They are only ever compared
 * against other times on the same Saturday, so a plain string keeps the
 * optimizer pure and the JSON payloads readable. See lib/time.ts.
 */

export type JobType = "changeover" | "house_cleaning" | "linens" | "other";
export type Confidence = "high" | "medium" | "low";
export type ScheduleStatus = "draft" | "final";

/** One row of the scheduling-app export, exactly as SheetJS read it. */
export type RawRow = {
  date?: string;
  customer?: string;
  firstName?: string;
  lastName?: string;
  address?: string;
  description?: string;
  notes?: string;
  /** Anything the export had that we did not recognise. Kept for auditability. */
  extra?: Record<string, string>;
};

/**
 * What the parsing layer produces per job. This is exactly the shape the Claude
 * call is constrained to (lib/parse/schema.ts) so there is one contract, not two.
 */
export type ParsedJob = {
  customer: string;
  address: string;
  job_type: JobType;
  window_start: string;
  window_end: string;
  /** Set when the notes pin a fixed appointment time, e.g. "11:30 please keep". */
  pinned_time: string | null;
  /** Key/lockbox/door codes. Never logged, never sent to the optimizer. */
  access: string | null;
  /** Cleaner-facing special instructions. */
  instructions: string | null;
  confidence: Confidence;
  /** Human-readable notes on anything that was assumed. Surfaces first on review. */
  flags: string[];
};

/** A job as stored: the parse plus identity, overrides and geocoding. */
export type Job = {
  id: string;
  scheduleId: string;
  houseId: string;
  customerId: string;
  raw: RawRow;
  parsed: ParsedJob;
  /** Fields the scheduler corrected on the review screen, applied over `parsed`. */
  overrides: Partial<ParsedJob>;
  confirmed: boolean;
};

/** The effective view of a job: parsed with the scheduler's corrections applied. */
export type EffectiveJob = ParsedJob & {
  id: string;
  houseId: string;
  customerId: string;
  confirmed: boolean;
  town: string;
  lat: number | null;
  lng: number | null;
  /** Minutes on site. Learned per house where history supports it. */
  durationMinutes: number;
};

export type House = {
  id: string;
  normalizedAddress: string;
  displayAddress: string;
  town: string;
  lat: number | null;
  lng: number | null;
  /** Null until history says otherwise; the optimizer falls back to 90 minutes. */
  durationEstimateMinutes: number | null;
  /** How the coordinates were obtained. Surfaced so estimates are never silent. */
  geoSource: "google" | "gazetteer" | null;
};

export type Customer = {
  id: string;
  name: string;
  houseId: string;
  /** Access info and instructions that recur for this customer, accumulated. */
  standingNotes: string | null;
};

export type Schedule = {
  id: string;
  /** ISO date, e.g. "2026-07-25". Saturdays only in v1. */
  date: string;
  teamCount: number;
  status: ScheduleStatus;
  createdAt: string;
  finalizedAt: string | null;
  /** Whether the parse came from Claude or the deterministic fallback. */
  parseSource: "claude" | "heuristic";
  /** Whether distances came from Google or the haversine fallback. */
  distanceSource: "google" | "haversine" | null;
  /** Set when the AI parse degraded, so the review screen can say why. */
  parseNote: string | null;
  /** Total drive time across all routes, in minutes. Null before the first build. */
  totalDriveMinutes: number | null;
  /** Jobs the optimizer could not place. Surfaced in a tray, never hidden. */
  unschedulable: { jobId: string; reason: string }[];
  /**
   * The drive-time matrix from the last build, cached against the schedule so
   * drag-and-drop adjustments recompute times instantly and never re-call the
   * distance API. `jobIds` gives the row/column order.
   */
  matrix: { jobIds: string[]; minutes: number[][] } | null;
};

export type RouteStop = {
  jobId: string;
  position: number;
  estArrival: string;
  estFinish: string;
  /** True once the scheduler has dragged or reordered this stop. */
  wasMovedByUser: boolean;
};

export type Route = {
  id: string;
  scheduleId: string;
  position: number;
  /** Claude's suggestion. Advisory only — never feeds back into routing. */
  suggestedTeam: number | null;
  suggestionRationale: string | null;
  /** What the scheduler settled on. Defaults to the suggestion. */
  finalTeam: number | null;
  stops: RouteStop[];
};

export type Correction = {
  id: string;
  customerId: string;
  customerName: string;
  field: keyof ParsedJob;
  aiValue: string | null;
  userValue: string | null;
  createdAt: string;
};

/** One finalized team-to-house assignment. Powers team suggestions. */
export type Assignment = {
  id: string;
  scheduleId: string;
  date: string;
  houseId: string;
  team: number;
};

/** A recorded manual change relative to what the optimizer proposed. */
export type Override = {
  id: string;
  scheduleId: string;
  date: string;
  kind: "moved_team" | "reordered" | "reassigned_team";
  description: string;
  createdAt: string;
};

/** Everything a screen needs about one schedule, in one payload. */
export type ScheduleDetail = {
  schedule: Schedule;
  jobs: EffectiveJob[];
  /** Access codes, keyed by job id. Only sent to the review and export screens. */
  routes: Route[];
  /** Jobs the optimizer could not place inside their window. */
  unschedulable: { jobId: string; reason: string }[];
  totalDriveMinutes: number;
};
