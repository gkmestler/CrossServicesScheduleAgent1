# The Furies Scheduler — Build Specification

A scheduling assistant for The Furies (Cross Services Group's cleaning company) that takes the weekly changeover job export, cleans up the messy data, and produces an optimized route plan for every cleaning team. Built for one user: the Furies scheduler.

This document is written to be handed to Claude Code. Read the whole thing before writing code. The companion file BRAND.md (Cross Services Group brand spec) governs all visual decisions and is referenced throughout, not restated.

---

## 1. The problem in plain terms

Saturdays are changeover days on Cape Cod. Tenants leave a rental in the morning, new tenants arrive in the afternoon, and every house must be cleaned inside its window (typically 9 or 10am until 3 or 4pm). On a given Saturday there are roughly 30 to 35 jobs, cleaned by about 8 teams of 2, averaging 1.5 hours per house, so most teams do 3 to 4 jobs.

Today the scheduler builds this plan by hand: reading each job's notes to find the arrival window, mentally mapping addresses across Wellfleet, Truro, Eastham, and Chatham, and sequencing jobs so teams stay geographically tight. It works, but it takes a long time and clusters get missed (jobs on the same street assigned to different teams, a team bouncing between towns).

The tool's job in v1: **upload the export, get back a clean, optimized schedule**. The scheduler still enters the final plan into the company's existing scheduling app by hand. This tool is the brain, not the system of record.

## 2. Users and access

One user, the Furies scheduler. No roles, no team accounts, no sharing.

Auth: a single password gate is enough. Use a simple credential check against an environment variable with an httpOnly session cookie (or NextAuth credentials provider if that is faster to wire up). Do not build registration, password reset flows, or user management. The app must not be publicly reachable without the password because job notes contain door codes and lockbox combinations.

## 3. Scope

### In scope for v1
1. Upload the CSV/Excel export from the scheduling app
2. AI parsing of every job: extract the real arrival window, access info, and special instructions from messy notes
3. Review screen where the scheduler confirms or corrects the parsed data
4. Route optimization: group jobs into team routes by distance, respecting time windows
5. AI-suggested team assignment for each route (suggestion only, clearly labeled as such)
6. A schedule board the scheduler can adjust by drag and drop
7. Export views the scheduler can work from while entering the plan into the scheduling app
8. History: every finalized schedule and every manual correction is saved, and fed back into future runs so the system gets better over time

### Out of scope for v1 (do not build)
- Direct integration with the scheduling app (no confirmed API yet; revisit in v2)
- Team-to-house consistency optimization (same team cleans the same house weekly). The data model must support it (see section 8) but the optimizer should not enforce it yet. Distance and timing win over consistency, per the owner.
- Multi-day scheduling. Saturdays only for now.
- Notifying cleaners, texting, invoicing, payroll. None of that.

## 4. Input data: what the export actually looks like

Real export from Saturday, July 25 (34 jobs). Columns:

| Column | Contents | Reliability |
|---|---|---|
| Date | `7/25/2026 10:00` timestamp | The date is reliable. The time is the scheduler's previous manual guess, not the customer's window. Treat as a weak hint only. |
| Customer | Full name or organization | Reliable |
| First Name / Last Name | Split name, sometimes blank | Use Customer as the display name |
| Address | Full street address with town, state, zip | Reliable, geocodable |
| Description | Job type, e.g. `Furies - Change Over Cleaning` | Reliable but inconsistent spelling: "Change Over", "Changeover", "Cleaning - Change Over", plus `House Cleaning` and `Linens` job types. Normalize. |
| Notes | Free text | A mess. This is where the AI earns its keep. |

### What lives inside Notes, based on the real file
- **Arrival windows** in every format imaginable: `9-4`, `10-3`, `10am-4pm`, `10-3pm Time Frame`, `(10-3)`, `11-4`. Sometimes stated twice, sometimes contradicting the Date column.
- **Excel date-mangling**: two jobs have windows corrupted into dates. `3-Oct` means 10-3 and `4-Oct` means 10-4. The parser must catch this pattern explicitly.
- **Time locks**: about 5 jobs say things like `11:30am please keep at this time` or `Keep 7/25 at 10am`. These are fixed appointments, not flexible windows. The optimizer must treat them as pinned.
- **Access info**: key numbers (`Key - 1066`), lockbox codes (`Lockbox - 2887`), door codes (`door code 1313`), key pickup instructions (`Pick Up key from Jess at Duarte/Downey`), keys hidden under rocks and deck posts. Extract but never let this influence routing.
- **Special instructions**: fridge cleanouts, laundry transfers, coffee machine restocking, "thorough cleaning, was not happy last time," requests for specific cleaners by name. Extract into a cleaner-facing instructions field.
- **Empty notes**: 2 of 34 jobs have no notes at all. These need a default window (assume 10am-3pm, flag for the scheduler to confirm).
- **Duplicated text**: many notes repeat the same key code or window two or three times. Deduplicate in the parsed output.

The upload flow must accept both .csv and .xlsx since the scheduler downloads whatever the app gives him.

## 5. How the intelligence layer works

Three distinct jobs, and only two of them belong to Claude. Do not ask a language model to do distance math.

### 5a. Parsing (Claude)
One API call per upload, batching all jobs into a single request (34 jobs fits comfortably). Model: `claude-opus-4-8` via the Anthropic API, called server-side only. The prompt sends the raw rows plus the parsing rules from section 4 and demands strict JSON back:

```json
{
  "jobs": [{
    "customer": "Matthew Shears",
    "address": "155 Briar Ln, Wellfleet, MA 02667",
    "job_type": "changeover",
    "window_start": "10:00",
    "window_end": "16:00",
    "pinned_time": null,
    "access": "Key - 1066",
    "instructions": null,
    "confidence": "high",
    "flags": []
  }]
}
```

`confidence` is low when the window was guessed (empty notes, contradictory notes, date-mangled values), and every low-confidence job gets a human-readable flag string explaining what was assumed. The review screen surfaces these first.

The parsing prompt must also receive the **correction memory** (section 8): past cases where the scheduler fixed a parsed window or instruction, so recurring customers parse correctly the second time without asking.

### 5b. Geocoding and distances (Google Maps, deterministic, not Claude)
Something has to turn addresses into coordinates and coordinates into distances. Claude cannot do this reliably; a language model guessing lat/lngs or drive times will quietly produce bad routes. Use Google:

- **Geocoding API** to turn each address into lat/lng. Geocode once and cache the result in the database keyed by normalized address. Most customers recur weekly, so after a few Saturdays nearly every lookup is a cache hit and costs nothing.
- **Distance Matrix API** (or the newer Routes API `computeRouteMatrix`) for real drive times between all job locations. One matrix per schedule build, ~35 points, cached per schedule so drag-and-drop adjustments never re-call the API.
- Requires `GOOGLE_MAPS_API_KEY`. Restrict the key to these APIs and keep it server-side only. At this volume everything stays well inside Google's monthly free credit.

Still write the distance layer as one swappable module with a haversine fallback, so a missing or misbehaving key degrades to straight-line estimates instead of breaking schedule builds.

### 5c. Route optimization (code, not Claude)
This is a vehicle routing problem with time windows. At 35 jobs and 8 teams it is small enough for a good heuristic in TypeScript, running in a Vercel serverless function in well under a second:

1. Separate pinned jobs (fixed appointment times) and place them first as anchors on routes.
2. Cluster remaining jobs geographically (start teams in the dominant town, Wellfleet, with dedicated routes for outlying towns: the Truro cluster, the Chatham/Eastham outliers).
3. Greedy insertion: assign each job to the route where it adds the least drive time while keeping every job's finish time (arrival + estimated duration) inside its window. Default duration 1.5 hours per house unless history says otherwise.
4. Improvement pass: 2-opt swaps within routes and relocations between routes until no move improves total drive time.
5. Validate: every job inside its window, no team over its job count, pinned times respected. Any job that cannot fit anywhere gets surfaced as unschedulable rather than silently squeezed.

The optimizer outputs per-team routes with estimated arrival and finish times per stop.

### 5d. Team suggestions and explanation (Claude)
A second Claude call takes the computed routes plus the assignment history and returns: which team number should take each route (based on which teams cleaned those houses before), and a two-sentence plain-language rationale per route ("Route C is the Truro loop; Team 3 did two of these houses last Saturday"). Suggestions render with a "suggested" tag the scheduler can accept or override in one tap. Routing itself never changes based on this call.

## 6. UI specification

All visual decisions come from BRAND.md. This section covers what the screens are, not how they look, with a few product-specific notes where the brand system meets this app.

The checklist is the brand signature and it is genuinely functional here: this is a tool about working through a list of houses. Use the checkbox mark for job states everywhere (parsed/confirmed on the review screen, cleaned-status is out of scope but the visual language still applies to confirm actions). Do not add a decorative strike-through animation to working screens; save personality for the empty states.

### Screen 1: Upload
Drag-and-drop zone plus a file picker, accepting .csv and .xlsx. Below it, a short list of recent Saturdays (from history) linking to their saved schedules. Empty state on first run explains the three steps: upload, review, schedule. Parsing progress shows as a plain status line, not a fake percentage bar.

### Screen 2: Review parsed jobs
A table of all jobs: customer, town, window, pinned time if any, access info (masked by default, tap to reveal), instructions, confidence. Low-confidence jobs sort to the top with their flag text in `--muted`. Every field is editable inline. Edits here are recorded as corrections (section 8). A count line anchors the screen: "34 jobs, 3 need review." Primary action: "Build schedule."

### Screen 3: Schedule board
The main event. One column per team, ordered stops within each column showing customer, street and town, estimated arrival and finish, window as a small mono tag, and a pin icon on time-locked jobs. Above the board: date, team count (editable, default 8, rebuilding routes on change), total drive time, and any unschedulable jobs in a clearly separated tray.

Interactions:
- Drag a job between teams or reorder within a team. On drop, recompute that route's times client-side and show window violations immediately (the violated stop's time tag turns into a warning state, using text and an icon, not color alone).
- Each team column header shows the suggested team number with its one-line rationale, tappable to reassign.
- A map toggle showing all stops colored by route, using the Google Maps JavaScript API (pins only, no route polylines needed in v1). Use a separate browser-restricted key for the client-side map, distinct from the server key.
- "Finalize schedule" saves the plan to history, including every manual change the scheduler made relative to what the optimizer proposed.

### Screen 4: Export view
What the scheduler reads while typing the plan into the scheduling app. One card per team: numbered stops with customer, address, arrival time, window, access info in mono, and instructions. Two actions per card: copy as plain text, and a print stylesheet that puts one team per page so route sheets can be handed to teams if desired.

Mobile matters: the scheduler will check this from a phone. The board becomes swipeable team cards on small screens. Follow BRAND.md breakpoints and tap target rules.

### Header
Type-only lockup (BRAND.md notes the logo is a white-background .webp that cannot sit on colored surfaces; do not use the image file). "Cross Services Group" in the display face with "The Furies Scheduler" as a mono eyebrow beneath it.

## 7. Learning over time

Be precise about what "learning" means here: no model training, no fine-tuning. The system improves by accumulating structured history and feeding the relevant slice into each Claude call and into optimizer defaults. This is simple and it genuinely compounds:

1. **Correction memory.** When the scheduler edits a parsed field on the review screen, store the customer, the field, what Claude said, and what the scheduler changed it to. Future parsing calls receive corrections for customers present in the upload. Recurring customers (most of them) stop parsing wrong after one fix.
2. **Duration learning.** When a finalized schedule's manual edits imply a house needs more than the default slot (the scheduler consistently gives it more room), or once actual durations exist in v2, store a per-house duration estimate the optimizer uses instead of the 1.5-hour default.
3. **Assignment history.** Every finalized schedule records which team took which house. This powers the team suggestions in 5d and is the foundation for the v2 consistency feature.
4. **Preference notes.** When the scheduler moves a job between teams or reorders stops before finalizing, store the diff. The team-suggestion prompt receives a summary of recent overrides ("scheduler keeps moving the Chequessett Neck house to the early slot") so suggestions drift toward how he actually schedules.

## 8. Data model

Postgres via Supabase (decided; the project lives in Supabase org `lnygfnvjgnyhrdnocvnm`). Use Supabase purely as a Postgres host: connect with the pooled connection string (Supavisor, transaction mode) since Vercel serverless functions need pooling. Do not use Supabase Auth, Row Level Security policies, or the client-side supabase-js SDK; the app has its own password gate and all database access happens server-side through the ORM. Tables:

- `houses` — normalized address, lat/lng, town, duration_estimate_minutes, created_at
- `customers` — name, house_id, standing_notes (accumulated access info and instructions that recur)
- `schedules` — date, team_count, status (draft/final), created_at
- `jobs` — schedule_id, house_id, customer_id, raw_row (jsonb), parsed (jsonb), confidence, window_start, window_end, pinned_time
- `routes` — schedule_id, position, suggested_team, final_team
- `route_stops` — route_id, job_id, position, est_arrival, est_finish, was_moved_by_user (boolean)
- `corrections` — customer_id, field, ai_value, user_value, created_at

Access codes live in the database as regular fields. Do not log them, do not put them in error messages, do not include them in the optimizer payload. They only travel in parsing input/output and the export view.

## 9. Stack and architecture

- **Next.js 15, App Router, TypeScript**, deployed on Vercel, repo on GitHub
- **Anthropic API** (`claude-opus-4-8`) called only from server routes; `ANTHROPIC_API_KEY` in Vercel env vars, never in client code
- **Google Maps**: Geocoding + Distance Matrix server-side, Maps JavaScript API for the board's map view
- **Supabase Postgres** with Drizzle ORM (light, typed, no codegen ceremony); pooled connection string in `DATABASE_URL`, no supabase-js
- **Tailwind** configured with the BRAND.md tokens as the theme; fonts via `next/font` (Newsreader, IBM Plex Sans, IBM Plex Mono)
- **xlsx parsing** with SheetJS server-side so .csv and .xlsx go through one path
- **No component library** (BRAND.md hard no). Build the small set of primitives by hand: button variants, input, table, tag, card.

Environment variables: `ANTHROPIC_API_KEY`, `GOOGLE_MAPS_API_KEY` (server, geocoding + distances), `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` (client, map view, browser-restricted), `DATABASE_URL`, `APP_PASSWORD`, `SESSION_SECRET`.

Estimated running cost: single-digit dollars per month. Two Opus calls per Saturday costs well under a dollar; geocoding is cached and the weekly distance matrix stays inside Google's monthly free credit.

## 10. Build order

1. **Foundation**: repo, Next.js, Tailwind themed from BRAND.md, font setup, password gate, Supabase + schema, deploy pipeline to Vercel working end to end before any features
2. **Upload + parse**: file upload, SheetJS ingestion, the Claude parsing call, review screen with inline editing and correction capture
3. **Routing**: geocode with caching, distance matrix, the heuristic optimizer as a pure, unit-tested TypeScript module (test it against the real July 25 file; a correct schedule keeps the Truro seven together and doesn't strand Chatham)
4. **Board**: schedule board with drag and drop, client-side time recomputation, window violation warnings, map toggle
5. **Suggestions + export**: team suggestion call, export cards, print stylesheet
6. **History + learning**: finalize flow, schedules list on the upload screen, correction memory wired into parsing, override summaries wired into suggestions

Each phase should end deployed and clickable. The scheduler should be able to start using it after phase 3 even with a plain list instead of the board.

## 11. v2 and beyond (documented so v1 doesn't paint us into a corner)

- **Scheduling app API/MCP integration** to pull jobs directly instead of manual export. Blocked on identifying what the app offers. (Open question: confirm the app's name and check its docs for an API.)
- **Team-house consistency** as a soft constraint: prefer keeping a team on houses it has cleaned before when it costs less than N extra minutes of drive time, with N tunable. Assignment history already captures the data.
- **Other days of the week**, which are simpler (no changeover windows).
- **Actual duration capture** (teams check in/out) to replace estimates.
- **Shared access** if more office staff start using it.

## 12. Open items for the scheduler

1. Name of the scheduling app the export comes from, to research API options for v2
2. A Google Cloud account with billing enabled, plus two API keys: a server key (Geocoding + Distance Matrix) and a browser-restricted key (Maps JavaScript API)
3. The SVG logo files noted in BRAND.md, whenever they arrive; the type-only lockup works until then