import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { getClaude, isClaudeConfigured, PARSING_MODEL } from "@/lib/anthropic";
import { ParseResponseSchema } from "@/lib/parse/schema";
import { PARSING_RULES, parseRowHeuristically } from "@/lib/parse/rules";
import type { Correction, ParsedJob, RawRow } from "@/lib/types";
import { isValidTime } from "@/lib/time";

export type ParseOutcome = {
  jobs: ParsedJob[];
  source: "claude" | "heuristic";
  /** Set when Claude was configured but the call did not succeed. */
  degradedReason?: string;
};

const SYSTEM_PROMPT = `
You clean up the weekly changeover job export for The Furies, a Cape Cod cleaning
company, so it can be routed. Saturdays are changeover days: tenants leave a
rental in the morning, new tenants arrive in the afternoon, and every house must
be cleaned inside its window.

Your entire job is to read messy free-text notes and return structured data. You
do not schedule, you do not estimate drive times, and you do not decide which
team goes where. Those are handled elsewhere by code.

${PARSING_RULES}

OUTPUT
- Return one entry per input row, in the same order, echoing row_index unchanged.
- Never drop a row. A row you cannot make sense of still gets an entry, with
  confidence "low" and a flag explaining what was unreadable.
- Never invent an address, a code, or an instruction that is not in the source.
`.trim();

/** The rows, formatted compactly. The Date column time is a weak hint only. */
function formatRows(rows: RawRow[]): string {
  return rows
    .map((row, index) => {
      const lines = [
        `ROW ${index}`,
        `Customer: ${row.customer ?? [row.firstName, row.lastName].filter(Boolean).join(" ") ?? ""}`,
        `Address: ${row.address ?? ""}`,
        `Description: ${row.description ?? ""}`,
        // Called out as unreliable so the model does not treat it as the window.
        `Date cell (date reliable, time is the scheduler's previous manual guess — weak hint only): ${row.date ?? ""}`,
        `Notes: ${row.notes?.trim() ? row.notes.trim() : "(none)"}`,
      ];
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * Correction memory: past cases where the scheduler fixed a parsed field for a
 * customer present in this upload. This is the whole of the "learning" — no
 * training, just the relevant slice of history in the prompt.
 */
function formatCorrections(corrections: Correction[]): string {
  if (corrections.length === 0) return "";
  const lines = corrections.map(
    (c) =>
      `- ${c.customerName} / ${c.field}: you previously returned ${JSON.stringify(
        c.aiValue,
      )} and the scheduler corrected it to ${JSON.stringify(c.userValue)}.`,
  );
  return `
CORRECTIONS THE SCHEDULER HAS ALREADY MADE FOR THESE CUSTOMERS
These are recurring customers whose parse you got wrong before. Unless this
week's notes clearly say something different, follow the correction.

${lines.join("\n")}
`.trim();
}

/** Fields a stored correction is allowed to overwrite on a fresh parse. */
const CORRECTABLE = new Set<keyof ParsedJob>([
  "customer",
  "address",
  "job_type",
  "window_start",
  "window_end",
  "pinned_time",
  "access",
  "instructions",
]);

/**
 * Replays the scheduler's past corrections over a freshly parsed set of jobs.
 *
 * Matching is by customer name, which is what the scheduler thinks in and what
 * the corrections table records. A corrected job is flagged so the review screen
 * shows why its value differs from what the notes literally say.
 */
function applyCorrections(jobs: ParsedJob[], corrections: Correction[]): ParsedJob[] {
  if (corrections.length === 0) return jobs;

  const byCustomer = new Map<string, Correction[]>();
  for (const correction of corrections) {
    const key = correction.customerName.trim().toLowerCase();
    byCustomer.set(key, [...(byCustomer.get(key) ?? []), correction]);
  }

  return jobs.map((job) => {
    const matches = byCustomer.get(job.customer.trim().toLowerCase());
    if (!matches || matches.length === 0) return job;

    const next: ParsedJob = { ...job, flags: [...job.flags] };
    for (const correction of matches) {
      if (!CORRECTABLE.has(correction.field)) continue;

      const current = next[correction.field];
      const currentText = current === null || current === undefined ? null : String(current);
      // If this week's notes already say what the scheduler corrected it to,
      // there is nothing to replay and nothing worth mentioning.
      if (currentText === correction.userValue) continue;

      // Times must stay parseable, or the optimizer inherits a broken window.
      const isTimeField =
        correction.field === "window_start" ||
        correction.field === "window_end" ||
        correction.field === "pinned_time";
      if (isTimeField && correction.userValue !== null && !isValidTime(correction.userValue)) {
        continue;
      }

      (next as Record<string, unknown>)[correction.field] = correction.userValue;
      next.flags.push(
        `Applied your earlier correction: ${correction.field.replace(/_/g, " ")} set to ${correction.userValue ?? "empty"} rather than the ${currentText ?? "empty"} in this week's notes.`,
      );
    }
    return next;
  });
}

/**
 * One API call per upload, batching every job. 34 jobs fits comfortably.
 *
 * If the key is missing or the call fails, this degrades to the deterministic
 * parser in lib/parse/rules.ts rather than failing the upload — the scheduler
 * still gets a reviewable table, clearly labelled as machine-parsed.
 */
export async function parseJobs(
  rows: RawRow[],
  corrections: Correction[],
): Promise<ParseOutcome> {
  if (rows.length === 0) return { jobs: [], source: "heuristic" };

  // The rule-based parser learns too. Corrections are applied over its output so
  // a customer the scheduler has already fixed stays fixed, whether or not the
  // AI is configured this week.
  const fallback = (): ParsedJob[] =>
    applyCorrections(rows.map(parseRowHeuristically), corrections);

  if (!isClaudeConfigured()) {
    return {
      jobs: fallback(),
      source: "heuristic",
      degradedReason: "ANTHROPIC_API_KEY is not configured.",
    };
  }

  const correctionBlock = formatCorrections(corrections);
  const userContent = [
    correctionBlock,
    `Here are ${rows.length} jobs from this Saturday's export. Parse every one.`,
    formatRows(rows),
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const message = await getClaude().messages.parse({
      model: PARSING_MODEL,
      max_tokens: 16000,
      // Adaptive thinking: the contradictory-notes cases genuinely need it, and
      // the model decides per job rather than us fixing a budget.
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: zodOutputFormat(ParseResponseSchema),
      },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    if (message.stop_reason === "refusal") {
      return {
        jobs: fallback(),
        source: "heuristic",
        degradedReason: "The parsing request was declined. Fell back to rule-based parsing.",
      };
    }

    const parsed = message.parsed_output;
    if (!parsed) {
      return {
        jobs: fallback(),
        source: "heuristic",
        degradedReason: "No structured output came back. Fell back to rule-based parsing.",
      };
    }

    // Realign by row_index so a reordered or missing entry can never shift a
    // door code onto the wrong house.
    const byIndex = new Map<number, (typeof parsed.jobs)[number]>();
    for (const job of parsed.jobs) byIndex.set(job.row_index, job);

    const jobs: ParsedJob[] = rows.map((row, index) => {
      const match = byIndex.get(index);
      if (!match) {
        const heuristic = parseRowHeuristically(row);
        return {
          ...heuristic,
          confidence: "low",
          flags: [
            ...heuristic.flags,
            "This job came back missing from the AI parse and was filled in by the rule-based parser.",
          ],
        };
      }

      // Times are schema-constrained, but validate anyway: a bad window would
      // otherwise reach the optimizer and quietly produce a wrong route.
      const timesValid =
        isValidTime(match.window_start) &&
        isValidTime(match.window_end) &&
        (match.pinned_time === null || isValidTime(match.pinned_time));

      if (!timesValid) {
        const heuristic = parseRowHeuristically(row);
        return {
          ...heuristic,
          confidence: "low",
          flags: [
            ...heuristic.flags,
            "The AI returned an unreadable time for this job. Rule-based parsing was used instead.",
          ],
        };
      }

      return {
        customer: match.customer,
        address: match.address,
        job_type: match.job_type,
        window_start: match.window_start,
        window_end: match.window_end,
        pinned_time: match.pinned_time,
        access: match.access,
        instructions: match.instructions,
        confidence: match.confidence,
        flags: match.flags ?? [],
      };
    });

    return { jobs, source: "claude" };
  } catch (error) {
    // Never let the access codes in the payload reach a log line.
    const reason = error instanceof Error ? error.message : "unknown error";
    return {
      jobs: fallback(),
      source: "heuristic",
      degradedReason: `The AI parse failed (${reason}). Fell back to rule-based parsing.`,
    };
  }
}
