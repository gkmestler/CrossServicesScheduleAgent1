import type { JobType } from "@/lib/types";

/**
 * What the board is allowed to know about a job.
 *
 * Deliberately narrower than EffectiveJob: no `access` field. Door codes and
 * lockbox combinations have nothing to do with deciding which team goes where,
 * so they never reach this screen. They appear on the export view only.
 */
export type BoardJob = {
  id: string;
  customer: string;
  address: string;
  town: string;
  windowStart: string;
  windowEnd: string;
  pinnedTime: string | null;
  durationMinutes: number;
  jobType: JobType;
  instructions: string | null;
  lat: number | null;
  lng: number | null;
};
