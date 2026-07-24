/**
 * Deterministic note-parsing rules.
 *
 * These are used three ways, deliberately from one place:
 *   1. as the fallback parser when ANTHROPIC_API_KEY is not configured
 *   2. as the source of the rule text embedded in the Claude prompt
 *   3. as the fixture the optimizer tests parse against, so tests never need a
 *      network call
 *
 * Nothing here guesses at geography or drive times — that is lib/geo.
 */

import type { Confidence, JobType, ParsedJob, RawRow } from "@/lib/types";
import { toHHMM } from "@/lib/time";

/** The window assumed when the notes say nothing at all. Always flagged. */
export const DEFAULT_WINDOW: { start: string; end: string } = { start: "10:00", end: "15:00" };

/**
 * Minutes on site when neither history nor the notes say otherwise.
 *
 * 90 minutes is the spec's stated average for a changeover clean. It is the
 * wrong number for the other job types, though — a linens run is a drop-off,
 * not a clean, and treating it as an hour and a half quietly costs a team a
 * whole slot. `defaultDurationFor` is what callers should use.
 */
export const DEFAULT_DURATION_MINUTES = 90;

const DURATION_BY_JOB_TYPE: Record<JobType, number> = {
  changeover: 90,
  house_cleaning: 90,
  linens: 20,
  other: 60,
};

export function defaultDurationFor(jobType: JobType): number {
  return DURATION_BY_JOB_TYPE[jobType] ?? DEFAULT_DURATION_MINUTES;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Collapses the repeated blocks the export is full of — many notes repeat the
 * same key code or window two or three times, sometimes with different casing
 * or trailing punctuation.
 */
export function dedupeNoteText(notes: string): string {
  if (!notes) return "";
  const pieces = notes
    .split(/[\n\r]+|(?<=[.;])\s+/)
    .map((piece) => piece.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const piece of pieces) {
    const key = piece.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    kept.push(piece);
  }
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Turns a bare hour pair from a changeover window into real times.
 *
 * Changeover windows always run morning-to-afternoon: tenants leave in the
 * morning and arrive in the afternoon. So the first number is am (8–12) and the
 * second is pm (1–8) unless the note says otherwise explicitly.
 */
export function resolveWindowPair(
  a: number,
  b: number,
  aMeridiem?: string | null,
  bMeridiem?: string | null,
  aMinutes = 0,
  bMinutes = 0,
): { start: string; end: string } | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 1 || a > 12 || b < 1 || b > 12) return null;

  // With no am/pm given, the opening hour of a changeover window is a morning
  // hour. "3-10" is not a window the scheduler would ever write; reading it as
  // 3am-10am would put a team at a house before dawn.
  if (!aMeridiem && (a < 7 || a > 12)) return null;

  const startHour = aMeridiem === "pm" && a !== 12 ? a + 12 : a === 12 && aMeridiem === "am" ? 0 : a;

  let endHour: number;
  if (bMeridiem === "am") {
    endHour = b === 12 ? 0 : b;
  } else if (bMeridiem === "pm") {
    endHour = b === 12 ? 12 : b + 12;
  } else {
    // No meridiem given. 1–8 is unambiguously afternoon for a changeover.
    endHour = b <= 8 ? b + 12 : b;
  }

  const start = startHour * 60 + aMinutes;
  const end = endHour * 60 + bMinutes;
  if (end <= start) return null;
  // A changeover window narrower than two hours or wider than ten is a misread.
  if (end - start < 60 || end - start > 600) return null;

  return { start: toHHMM(start), end: toHHMM(end) };
}

export type WindowMatch = {
  start: string;
  end: string;
  source: "explicit" | "excel_mangled";
  raw: string;
};

/**
 * Finds every arrival window stated in the notes, in any of the formats the real
 * export uses: `9-4`, `10-3`, `10am-4pm`, `10-3pm Time Frame`, `(10-3)`, `11-4`,
 * plus the two Excel-mangled ones (`3-Oct` meaning 10-3, `4-Oct` meaning 10-4).
 */
export function findWindows(notes: string): WindowMatch[] {
  const found: WindowMatch[] = [];
  if (!notes) return found;

  // Excel turned "10-3" into the date "3-Oct" (day 3 of October) and "10-4"
  // into "4-Oct". Recover the pair as (month number, day number). This has to
  // run first: the generic numeric pattern below would otherwise see nothing.
  const mangled = /\b(\d{1,2})\s*-\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/gi;
  for (const m of notes.matchAll(mangled)) {
    const day = Number(m[1]);
    const month = MONTHS[m[2].toLowerCase()];
    const resolved = resolveWindowPair(month, day);
    if (resolved) found.push({ ...resolved, source: "excel_mangled", raw: m[0] });
  }

  // ...and the same thing written the other way round, "Oct-3".
  const mangledReversed = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*-\s*(\d{1,2})\b/gi;
  for (const m of notes.matchAll(mangledReversed)) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = Number(m[2]);
    const resolved = resolveWindowPair(month, day);
    if (resolved) found.push({ ...resolved, source: "excel_mangled", raw: m[0] });
  }

  // The ordinary forms. Optional minutes and optional am/pm on either side.
  const explicit =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|\bto\b|\buntil\b)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/gi;
  for (const m of notes.matchAll(explicit)) {
    // Skip anything that is actually a date: "7/25" or "2026-07-25".
    const before = notes.slice(Math.max(0, m.index - 1), m.index);
    const after = notes.slice(m.index + m[0].length, m.index + m[0].length + 1);
    if (before === "/" || after === "/" || after === "-") continue;

    const resolved = resolveWindowPair(
      Number(m[1]),
      Number(m[4]),
      m[3]?.toLowerCase() ?? null,
      m[6]?.toLowerCase() ?? null,
      Number(m[2] ?? 0),
      Number(m[5] ?? 0),
    );
    if (resolved) found.push({ ...resolved, source: "explicit", raw: m[0] });
  }

  // Dedupe identical windows found more than once (notes repeat themselves).
  const seen = new Set<string>();
  return found.filter((w) => {
    const key = `${w.start}-${w.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Detects a time lock — a fixed appointment rather than a flexible window.
 * About five jobs a week say things like "11:30am please keep at this time" or
 * "Keep 7/25 at 10am". The optimizer treats these as pinned anchors.
 */
export function findPinnedTime(notes: string): string | null {
  if (!notes) return null;
  const lockLanguage =
    /(keep|hold|fixed|must be|no earlier|no later|please keep|stay at|scheduled for|arrive at|start at)/i;
  if (!lockLanguage.test(notes)) return null;

  // Prefer a time that sits near the locking phrase.
  const timePattern = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi;
  const candidates = [...notes.matchAll(timePattern)];
  if (candidates.length === 0) return null;

  for (const m of candidates) {
    const context = notes.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
    if (!lockLanguage.test(context)) continue;
    // A locked time inside a "10-3" range is the range, not a lock — skip pairs.
    const hour = Number(m[1]);
    const minutes = Number(m[2] ?? 0);
    const meridiem = m[3].toLowerCase();
    const h24 = meridiem === "pm" && hour !== 12 ? hour + 12 : meridiem === "am" && hour === 12 ? 0 : hour;
    return toHHMM(h24 * 60 + minutes);
  }
  return null;
}

/**
 * Pulls key numbers, lockbox codes, door codes and key-pickup instructions.
 *
 * These are sensitive. They live in the database as ordinary fields but are
 * never logged, never put in error messages, and never included in the payload
 * sent to the optimizer or the team-suggestion call.
 */
export function findAccess(notes: string): string | null {
  if (!notes) return null;
  const parts: string[] = [];

  // Every branch must require a code, or a bare "Lockbox" matches on its own and
  // ends up in the output next to the real "Lockbox - 5520".
  const codePatterns: RegExp[] = [
    /\b(?:keys?)\s*(?:#|no\.?|number)?\s*[-–:]?\s*(\d{3,6})\b/gi,
    /\block\s*-?\s*box\s*(?:code)?\s*[-–:]?\s*(\d{3,6})\b/gi,
    /\b(?:door|gate|garage|alarm|entry)\s*code\s*(?:is)?\s*[-–:]?\s*(\d{3,6})\b/gi,
    /\bcode\s*(?:is)?\s*[-–:]?\s*(\d{3,6})\b/gi,
  ];

  const found: { text: string; code: string }[] = [];
  for (const pattern of codePatterns) {
    for (const m of notes.matchAll(pattern)) {
      const text = m[0].replace(/\s{2,}/g, " ").trim();
      if (found.some((p) => p.text.toLowerCase() === text.toLowerCase())) continue;
      // The generic "code NNNN" pattern also matches inside "door code NNNN".
      // Keep the more specific phrasing and drop the bare restatement.
      if (found.some((p) => p.code === m[1] && p.text.length >= text.length)) continue;
      found.push({ text, code: m[1] });
    }
  }
  parts.push(...found.map((f) => f.text));

  // Key-location and pickup sentences: "Pick Up key from Jess at Duarte/Downey",
  // "key under the rock", "key on the deck post".
  const sentences = notes.split(/(?<=[.!?])\s+|\n+/);
  const locationLanguage =
    /(pick\s*up\s+key|key\s+(?:is\s+)?(?:under|behind|in|on|at|with|hidden)|hide[-\s]?a[-\s]?key|key\s+pickup|garage\s+code|realtor\s+box)/i;
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed || !locationLanguage.test(trimmed)) continue;
    if (!parts.some((p) => p.toLowerCase() === trimmed.toLowerCase())) parts.push(trimmed);
  }

  return parts.length > 0 ? parts.join("; ") : null;
}

/**
 * Everything a cleaner needs that is not access and not timing: fridge
 * cleanouts, laundry transfers, restocking, "thorough cleaning, was not happy
 * last time", requests for a named cleaner.
 */
export function findInstructions(notes: string): string | null {
  if (!notes) return null;
  const instructionLanguage =
    /(fridge|refrigerator|laundry|linens?|towels?|coffee|restock|thorough|deep clean|not happy|complain|please\s+\w+|asks? for|send\s+\w+|trash|recycl|grill|dishwasher|beds?|windows?|floors?|pet|dog|cat|do not|don't|owner)/i;

  const sentences = notes
    .split(/(?<=[.!?])\s+|\n+|;\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  const kept: string[] = [];
  for (const sentence of sentences) {
    if (!instructionLanguage.test(sentence)) continue;
    // Do not carry access codes across into the cleaner-facing field.
    if (/\b\d{3,6}\b/.test(sentence) && /(key|lockbox|code|alarm)/i.test(sentence)) continue;
    if (!kept.some((k) => k.toLowerCase() === sentence.toLowerCase())) kept.push(sentence);
  }

  return kept.length > 0 ? kept.join(" ") : null;
}

/**
 * The Description column is reliable but inconsistently spelled: "Change Over",
 * "Changeover", "Cleaning - Change Over", plus "House Cleaning" and "Linens".
 */
export function normalizeJobType(description: string | undefined): JobType {
  const text = (description ?? "").toLowerCase();
  if (/change\s*-?\s*over|changeover|turn\s*over/.test(text)) return "changeover";
  if (/linen/.test(text)) return "linens";
  if (/house\s*clean|home\s*clean|cleaning/.test(text)) return "house_cleaning";
  if (!text.trim()) return "other";
  return "other";
}

/** Normalized address key for geocode caching and house identity. */
export function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\b(street|str)\b/g, "st")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(avenue|ave\.)\b/g, "ave")
    .replace(/\b(court)\b/g, "ct")
    .replace(/\b(circle)\b/g, "cir")
    .replace(/\b(place)\b/g, "pl")
    .replace(/\b(terrace)\b/g, "ter")
    .replace(/\b(way)\b/g, "way")
    .replace(/\bmassachusetts\b/g, "ma")
    .replace(/\s+/g, " ")
    .trim();
}

/** The Cape towns this operation covers, plus a couple of neighbours. */
const KNOWN_TOWNS = [
  "wellfleet", "truro", "north truro", "eastham", "chatham", "orleans",
  "brewster", "provincetown", "harwich", "dennis",
];

/** Pulls the town out of a full street address. */
export function extractTown(address: string): string {
  const lower = address.toLowerCase();
  // Prefer the longest match so "north truro" beats "truro".
  const matches = KNOWN_TOWNS.filter((town) => lower.includes(town)).sort(
    (a, b) => b.length - a.length,
  );
  if (matches[0]) {
    return matches[0]
      .split(" ")
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ");
  }
  // Fall back to the comma-separated segment before the state.
  const parts = address.split(",").map((p) => p.trim());
  const stateIndex = parts.findIndex((p) => /^(ma|mass|massachusetts)\b/i.test(p));
  if (stateIndex > 0) return parts[stateIndex - 1];
  return "Unknown";
}

/**
 * The deterministic parser. Used verbatim when no Anthropic key is configured,
 * and as a pre-pass whose output the Claude prompt sees as a starting point.
 */
export function parseRowHeuristically(row: RawRow): ParsedJob {
  const notes = dedupeNoteText(row.notes ?? "");
  const flags: string[] = [];
  let confidence: Confidence = "high";

  const windows = findWindows(notes);
  let start = DEFAULT_WINDOW.start;
  let end = DEFAULT_WINDOW.end;

  if (windows.length === 0) {
    confidence = "low";
    flags.push(
      notes.trim().length === 0
        ? "No notes on this job. Assumed the default 10-3 window — confirm before scheduling."
        : "No arrival window found in the notes. Assumed the default 10-3 window.",
    );
  } else {
    const chosen = windows[0];
    start = chosen.start;
    end = chosen.end;

    if (chosen.source === "excel_mangled") {
      confidence = "low";
      flags.push(
        `The window was mangled into a date by Excel ("${chosen.raw}"). Read as ${windows[0].start}-${windows[0].end}.`,
      );
    }

    if (windows.length > 1) {
      confidence = "low";
      const alternatives = windows
        .slice(1)
        .map((w) => `${w.start}-${w.end}`)
        .join(", ");
      flags.push(
        `The notes state more than one window. Used ${start}-${end}; also saw ${alternatives}.`,
      );
    }
  }

  const pinnedTime = findPinnedTime(notes);
  if (pinnedTime) {
    flags.push(`Time lock: this job is pinned to ${pinnedTime} and will not be moved.`);
  }

  const customer = (row.customer ?? `${row.firstName ?? ""} ${row.lastName ?? ""}`).trim();
  if (!customer) {
    confidence = "low";
    flags.push("No customer name in the export row.");
  }

  const address = (row.address ?? "").trim();
  if (!address) {
    confidence = "low";
    flags.push("No address in the export row. This job cannot be routed until one is added.");
  }

  return {
    customer: customer || "Unknown customer",
    address,
    job_type: normalizeJobType(row.description),
    window_start: start,
    window_end: end,
    pinned_time: pinnedTime,
    access: findAccess(notes),
    instructions: findInstructions(notes),
    confidence,
    flags,
  };
}

/**
 * The rule text handed to Claude. Kept next to the implementation so the two
 * cannot drift: if a rule changes here, the prompt changes with it.
 */
export const PARSING_RULES = `
ARRIVAL WINDOWS
- Windows appear in every format imaginable: "9-4", "10-3", "10am-4pm", "10-3pm Time Frame", "(10-3)", "11-4".
- Changeover windows always run morning to afternoon. The first number is AM (8-12), the second is PM (1-8), unless am/pm is stated explicitly.
- A window is sometimes stated two or three times in the same note, occasionally contradicting itself. If the notes disagree, pick the one stated most often or most specifically, set confidence to "low", and flag exactly what the disagreement was.

EXCEL DATE MANGLING - CHECK FOR THIS EXPLICITLY
- Excel converted some windows into dates. "3-Oct" means the window 10-3 (10:00-15:00). "4-Oct" means 10-4 (10:00-16:00).
- The rule: read <day>-<Month> as (month number, day number) and treat that pair as the hour window. October is month 10, so "3-Oct" is the pair (10, 3).
- Any job parsed this way gets confidence "low" and a flag naming the mangled text.

TIME LOCKS
- Roughly five jobs a week are fixed appointments rather than flexible windows: "11:30am please keep at this time", "Keep 7/25 at 10am", "must be there at 9".
- Put the fixed time in pinned_time as HH:MM. Still fill window_start and window_end (use the stated window if there is one, otherwise a two-hour window around the pinned time).
- A pinned job always gets a flag saying so.

ACCESS INFORMATION
- Extract key numbers ("Key - 1066"), lockbox codes ("Lockbox - 2887"), door codes ("door code 1313"), gate and alarm codes, key pickup instructions ("Pick Up key from Jess at Duarte/Downey"), and keys hidden under rocks or deck posts.
- Put all of it in the access field, semicolon-separated. Deduplicate: notes frequently repeat the same code two or three times.
- Access information must never appear in the instructions field.

SPECIAL INSTRUCTIONS
- Extract anything a cleaner needs to do differently: fridge cleanouts, laundry transfers, coffee machine restocking, "thorough cleaning, was not happy last time", requests for a specific cleaner by name.
- Write these as cleaner-facing prose. Do not include codes or timing here.

EMPTY NOTES
- Some jobs have no notes at all. Use the default window 10:00-15:00, set confidence "low", and flag that the window was assumed.

JOB TYPE
- The Description column is reliable but inconsistently spelled: "Change Over", "Changeover", "Cleaning - Change Over" all mean changeover. "House Cleaning" and "Linens" are separate job types.
- Normalize to exactly one of: changeover, house_cleaning, linens, other.

DUPLICATED TEXT
- Many notes repeat the same key code or window two or three times. Deduplicate everything in the parsed output.

CONFIDENCE AND FLAGS
- confidence is "low" whenever the window was guessed: empty notes, contradictory notes, or date-mangled values. It is "medium" when the window was found but something else was ambiguous. Otherwise "high".
- Every low-confidence job must carry at least one flag, written as a plain sentence the scheduler can act on. Say what you assumed and why.
`.trim();
