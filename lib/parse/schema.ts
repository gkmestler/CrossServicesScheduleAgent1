import * as z from "zod/v4";

/**
 * The JSON contract for the parsing call. This schema is handed to the API as a
 * structured-output format, so the model is constrained to it rather than asked
 * politely for it — there is no hand-rolled JSON repair anywhere in this app.
 *
 * Kept deliberately close to ParsedJob in lib/types.ts; parseJobs() maps between
 * them and validates the times.
 */

export const JOB_TYPES = ["changeover", "house_cleaning", "linens", "other"] as const;
export const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;

const TIME = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, "must be a 24-hour HH:MM time");

export const ParsedJobSchema = z.object({
  /**
   * Echoed back so a reordered or dropped job is detectable rather than
   * silently misaligned with the source rows.
   */
  row_index: z.number().int().describe("The index of the source row, echoed back unchanged."),
  customer: z.string().describe("Display name for the job. Use the Customer column."),
  address: z.string().describe("Full street address including town, state and zip."),
  job_type: z.enum(JOB_TYPES),
  window_start: TIME.describe("Earliest arrival, 24-hour HH:MM."),
  window_end: TIME.describe("Latest finish, 24-hour HH:MM."),
  pinned_time: TIME.nullable().describe(
    "Fixed appointment time if the notes lock one, otherwise null.",
  ),
  access: z
    .string()
    .nullable()
    .describe("Key numbers, lockbox and door codes, key pickup instructions. Null if none."),
  instructions: z
    .string()
    .nullable()
    .describe("Cleaner-facing special instructions. Never timing or access codes. Null if none."),
  confidence: z.enum(CONFIDENCE_LEVELS),
  flags: z
    .array(z.string())
    .describe(
      "One plain sentence per assumption made. Required and non-empty when confidence is low.",
    ),
});

export const ParseResponseSchema = z.object({
  jobs: z.array(ParsedJobSchema),
});

export type ParseResponse = z.infer<typeof ParseResponseSchema>;

/* -------------------------------------------------------------------------- */
/* Team suggestion                                                            */
/* -------------------------------------------------------------------------- */

export const SuggestionSchema = z.object({
  route_id: z.string().describe("The route id, echoed back unchanged."),
  team: z.number().int().describe("Suggested team number, 1-based."),
  rationale: z
    .string()
    .describe("Two sentences, plain language, naming the towns and the history behind the pick."),
});

export const SuggestResponseSchema = z.object({
  suggestions: z.array(SuggestionSchema),
});

export type SuggestResponse = z.infer<typeof SuggestResponseSchema>;
