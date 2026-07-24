import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dedupeNoteText,
  findAccess,
  findInstructions,
  findPinnedTime,
  findWindows,
  normalizeJobType,
  parseRowHeuristically,
  resolveWindowPair,
  extractTown,
} from "../lib/parse/rules.ts";

/* -------------------------------------------------------------------------- */
/* Windows                                                                    */
/* -------------------------------------------------------------------------- */

test("reads every window format the real export uses", () => {
  const cases: [string, string, string][] = [
    ["9-4", "09:00", "16:00"],
    ["10-3", "10:00", "15:00"],
    ["10am-4pm", "10:00", "16:00"],
    ["10-3pm Time Frame", "10:00", "15:00"],
    ["(10-3)", "10:00", "15:00"],
    ["11-4", "11:00", "16:00"],
    ["10-4", "10:00", "16:00"],
    ["9:30-2:30", "09:30", "14:30"],
  ];

  for (const [notes, start, end] of cases) {
    const found = findWindows(notes);
    assert.ok(found.length > 0, `no window found in ${JSON.stringify(notes)}`);
    assert.equal(found[0].start, start, `start for ${notes}`);
    assert.equal(found[0].end, end, `end for ${notes}`);
  }
});

test("recovers the two Excel date-mangled windows", () => {
  // "3-Oct" is October 3rd as far as Excel is concerned; it means 10-3.
  const october3 = findWindows("3-Oct");
  assert.equal(october3.length, 1);
  assert.deepEqual(
    { start: october3[0].start, end: october3[0].end, source: october3[0].source },
    { start: "10:00", end: "15:00", source: "excel_mangled" },
  );

  const october4 = findWindows("4-Oct  door code 1313");
  assert.equal(october4[0].start, "10:00");
  assert.equal(october4[0].end, "16:00");
  assert.equal(october4[0].source, "excel_mangled");
});

test("a mangled window makes the job low confidence and flags what was assumed", () => {
  const job = parseRowHeuristically({
    customer: "Susan Marchetti",
    address: "88 Kendrick Ave, Wellfleet, MA 02667",
    description: "Furies - Change Over",
    notes: "3-Oct",
  });

  assert.equal(job.window_start, "10:00");
  assert.equal(job.window_end, "15:00");
  assert.equal(job.confidence, "low");
  assert.ok(
    job.flags.some((f) => f.includes("3-Oct")),
    "the flag should name the mangled text so the scheduler can check it",
  );
});

test("does not read a date as a window", () => {
  assert.equal(findWindows("Cleaned on 7/25 as usual").length, 0);
  assert.equal(findWindows("scheduled 2026-07-25").length, 0);
});

test("rejects nonsense hour pairs rather than inventing a window", () => {
  assert.equal(resolveWindowPair(10, 10), null, "a zero-length window is not a window");
  assert.equal(resolveWindowPair(3, 10), null, "3am to 10am is not a changeover window");
  assert.equal(resolveWindowPair(13, 4), null, "13 is not a valid clock hour here");
});

/* -------------------------------------------------------------------------- */
/* Time locks                                                                 */
/* -------------------------------------------------------------------------- */

test("finds time locks in the phrasings the scheduler actually gets", () => {
  assert.equal(findPinnedTime("11:30am please keep at this time"), "11:30");
  assert.equal(findPinnedTime("Keep 7/25 at 10am"), "10:00");
  assert.equal(findPinnedTime("Please keep at 9:30am - guest arriving early. 9:30-2:30."), "09:30");
  assert.equal(
    findPinnedTime("Must be there at 1pm - the owner is showing the house in the morning. 12-4."),
    "13:00",
  );
});

test("does not treat an ordinary window as a time lock", () => {
  assert.equal(findPinnedTime("10-3 time frame"), null);
  assert.equal(findPinnedTime("10am-4pm. Key is under the rock."), null);
});

/* -------------------------------------------------------------------------- */
/* Access and instructions                                                    */
/* -------------------------------------------------------------------------- */

test("extracts access info in each of its shapes and deduplicates it", () => {
  assert.match(findAccess("Key - 1066. Key - 1066. 10-3 time frame.") ?? "", /1066/);
  assert.match(findAccess("10-3 Lockbox - 2887") ?? "", /2887/);
  assert.match(findAccess("4-Oct  door code 1313") ?? "", /1313/);
  assert.match(findAccess("10-3 gate code 8821") ?? "", /8821/);
  assert.match(
    findAccess("10-3. Pick Up key from Jess at Duarte/Downey.") ?? "",
    /Pick Up key from Jess/i,
  );
  assert.match(
    findAccess("10-3. Key is behind the deck post on the ocean side.") ?? "",
    /deck post/i,
  );

  // The same code stated three times comes back once.
  const repeated = findAccess("Key - 3390 10-3 Key - 3390 Key - 3390") ?? "";
  assert.equal(repeated.match(/3390/g)?.length, 1);
});

test("access codes never leak into the cleaner-facing instructions field", () => {
  const notes = "10-3pm Time Frame. Lockbox - 2887. Transfer the laundry to the dryer before you leave.";
  const instructions = findInstructions(notes) ?? "";
  assert.match(instructions, /laundry/i);
  assert.doesNotMatch(instructions, /2887/);
});

test("picks up the special instructions the spec calls out", () => {
  assert.match(findInstructions("Please clean out the fridge - previous guests left food.") ?? "", /fridge/i);
  assert.match(findInstructions("Restock the coffee machine - pods are in the pantry.") ?? "", /coffee/i);
  assert.match(
    findInstructions("Thorough cleaning please - guest was not happy last time.") ?? "",
    /not happy/i,
  );
  assert.match(
    findInstructions("Please send Maria if she is working - the owner asks for her.") ?? "",
    /Maria/,
  );
});

/* -------------------------------------------------------------------------- */
/* Everything else                                                            */
/* -------------------------------------------------------------------------- */

test("empty notes get the default window, low confidence and a flag", () => {
  const job = parseRowHeuristically({
    customer: "Thomas Kiley",
    address: "3 Bayberry Ln, Wellfleet, MA 02667",
    description: "Furies - Change Over Cleaning",
    notes: "",
  });

  assert.equal(job.window_start, "10:00");
  assert.equal(job.window_end, "15:00");
  assert.equal(job.confidence, "low");
  assert.equal(job.flags.length > 0, true);
});

test("normalizes the inconsistent Description spellings", () => {
  for (const description of [
    "Furies - Change Over Cleaning",
    "Furies - Changeover",
    "Furies - Cleaning - Change Over",
    "Furies - Changeover Cleaning",
    "Furies - Change Over",
  ]) {
    assert.equal(normalizeJobType(description), "changeover", description);
  }
  assert.equal(normalizeJobType("Furies - House Cleaning"), "house_cleaning");
  assert.equal(normalizeJobType("Furies - Linens"), "linens");
});

test("collapses repeated note blocks", () => {
  const deduped = dedupeNoteText("Key - 1066. Key - 1066. 10-3 time frame.");
  assert.equal(deduped.match(/1066/g)?.length, 1);
  assert.match(deduped, /10-3/);
});

test("reads the town out of a full street address", () => {
  assert.equal(extractTown("155 Briar Ln, Wellfleet, MA 02667"), "Wellfleet");
  assert.equal(extractTown("3 Highland Rd, North Truro, MA 02652"), "North Truro");
  assert.equal(extractTown("88 Shore Rd, Chatham, MA 02633"), "Chatham");
});

test("does not emit a bare keyword next to the code it belongs to", () => {
  // Regression: a broken alternation matched the word "Lockbox" on its own, so
  // the export view showed "Lockbox; Lockbox - 5520".
  assert.equal(findAccess("Keep 7/25 at 10am. Lockbox - 5520. Keep at 10am. 10-4."), "Lockbox - 5520");
  assert.equal(findAccess("10-3 Lockbox - 2887"), "Lockbox - 2887");
  assert.equal(findAccess("4-Oct  door code 1313"), "door code 1313");
  assert.equal(findAccess("10-3 gate code 8821"), "gate code 8821");
  assert.equal(findAccess("Key - 1066. Key - 1066."), "Key - 1066");
  // A bare keyword with no code is not access information.
  assert.equal(findAccess("There is a lockbox somewhere out front"), null);
});
