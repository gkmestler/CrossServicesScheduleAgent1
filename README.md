# The Furies Scheduler

Takes the weekly changeover job export, cleans up the messy data, and produces an
optimized route plan for every cleaning team. Built for one user: the Furies
scheduler at Cross Services Group.

The tool is the brain, not the system of record — the scheduler still enters the
final plan into the company's existing scheduling app by hand.

---

## Running it

```bash
npm install
cp .env.example .env.local     # set APP_PASSWORD and SESSION_SECRET
npm run dev
```

That is genuinely all that is needed. **Only `APP_PASSWORD` and `SESSION_SECRET`
are required.** Without the other keys the app degrades rather than breaking, and
says so on screen everywhere it matters:

| Missing | What happens instead | Where you're told |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | Notes are parsed by the deterministic rules in `lib/parse/rules.ts` | "Rule-based parse" banner on the review screen |
| `GOOGLE_MAPS_API_KEY` | Addresses land on town centroids; drive times are straight-line estimates | "(straight-line estimate)" next to the total on the board |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | The map toggle explains what key it needs | In place of the map |
| `DATABASE_URL` | Schedules are stored in a local `.data/scheduler.json` | "Local storage" chip in the header |

A `.env.local` with a development password is already present so `npm run dev`
works immediately. **Change it before this is reachable from anywhere but your
laptop** — job notes contain door codes and lockbox combinations.

Other commands:

```bash
npm test          # 29 tests, no network, runs in ~1s
npm run typecheck
npm run build
npm run db:generate   # regenerate the SQL migration after a schema change
npm run db:push       # apply the schema to DATABASE_URL
```

---

## How it fits together

```
upload  →  parse  →  review  →  build  →  board  →  export  →  finalize
                        │                                          │
                        └────────── corrections ───────────────────┤
                                    assignments ──────────────────┤
                                    overrides ────────────────────┘
                                          feed the next Saturday
```

Three distinct jobs, and only two of them belong to Claude:

**Parsing (Claude).** One API call per upload, batching all jobs. Constrained to
a JSON schema via structured outputs, so there is no hand-rolled JSON repair
anywhere. Reads the real arrival window out of notes written in every format
imaginable — including the two that Excel mangled into dates (`3-Oct` means
10-3). Low-confidence jobs carry a plain-English flag saying what was assumed.

**Geocoding and distances (Google, deterministic).** Claude is never asked to do
this: a language model guessing lat/lngs or drive times quietly produces bad
routes, which is worse than no routes. Geocodes are cached per normalized
address, so after a few Saturdays nearly every lookup is free. One distance
matrix per build, cached against the schedule, so drag-and-drop never re-calls
the API. `lib/geo/` is one swappable module with a haversine fallback.

**Route optimization (code).** A vehicle routing problem with time windows,
solved by a heuristic in `lib/optimize/index.ts`: pinned jobs anchor routes,
geographic seeds spread teams across towns, greedy insertion places the rest,
then 2-opt and inter-route relocation improve it. It runs four different
insertion orderings and keeps the best plan — see "Ordering matters" below.

Then, and only then, **team suggestions (Claude)** label the finished routes.
Routing never changes because of that call, and its payload deliberately contains
no access codes.

---

## Things worth knowing

### 34 jobs does not fit 8 teams

This came out of the tests and it is a real property of the work, not a bug.
Eight teams working a 9-4 window fit four 90-minute cleans each at the very best
— 32 slots for 34 jobs — and every pinned job that anchors a route at 10am costs
that route a slot. Ten teams covers the fixture Saturday with nothing left over.

The optimizer reports what it cannot place, with a reason per job, rather than
squeezing someone in and letting a team discover it on the day. The team count on
the board is editable for exactly this reason. If the real Saturday genuinely
runs on 8 teams, then some houses take less than 90 minutes, and duration
learning (below) is what will discover that.

### Ordering matters more than it looks

A team's day starts when it reaches its first house. Whether a 9-4 job or a 10-3
job lands on a route first decides whether that route fits three stops or four.
Placing the most-constrained job first — the textbook rule — turns out to be the
*worst* of the four orderings here, because it leaves the 9am-capable jobs until
last and every route ends up starting at 10. Trying all four and keeping the best
took the fixture from 10 unplaced jobs to 5 at the same team count.

### Durations are per job type

A linens run is a drop-off, not a clean. Treating it as an hour and a half was
quietly costing a team a whole slot. Changeover and house cleaning are 90
minutes, linens 20, anything else 60 — until history says otherwise per house.

### Access codes

Door codes, lockbox combinations and key-pickup instructions live in the database
as ordinary fields, and travel in exactly two places: the parsing input/output,
and the export view (which is the sheet the scheduler works from). They are
**not** in the board's payload, the optimizer's payload, the team-suggestion
prompt, any log line, or any error message. `components/screens/board-types.ts`
is deliberately narrower than `EffectiveJob` to enforce that at the type level.

### Learning

No model training. The system improves by accumulating structured history and
feeding the relevant slice into each call:

1. **Correction memory** — editing a parsed field on the review screen records
   what Claude said and what you changed it to. The next upload containing that
   customer gets those corrections in the prompt. The rule-based fallback replays
   them too, so the loop works even with no API key.
2. **Duration learning** — when you consistently give a house more room than the
   default slot, finalizing stores that as the house's estimate.
3. **Assignment history** — every finalized schedule records which team took
   which house. This powers the team suggestions.
4. **Preference notes** — moving a job between teams before finalizing stores the
   diff, and a summary goes into the next suggestion prompt.

---

## Layout

```
app/                     screens and route handlers
  page.tsx               1. upload
  review/[id]/           2. review parsed jobs
  board/[id]/            3. schedule board (the main event)
  export/[id]/           4. export view + print stylesheet
  api/                   upload, build, jobs, routes, finalize, auth
lib/
  parse/rules.ts         deterministic note parsing — also the source of the
                         rule text in the Claude prompt, so the two can't drift
  parse/claude.ts        the parsing call + correction replay
  parse/schema.ts        the JSON contract, as a zod schema
  optimize/index.ts      the VRPTW heuristic — pure, isomorphic, unit-tested
  geo/                   geocoding + distance matrix, with haversine fallback
  suggest.ts             the team-suggestion call
  schedule.ts            build orchestration
  db/                    Store interface + Postgres and JSON implementations
components/ui/           the whole primitive vocabulary (no component library)
tests/                   29 tests, no network
fixtures/                the synthetic July 25 export — see fixtures/README.md
```

`lib/optimize/index.ts` is pure and dependency-free, which is why the board can
re-run `evaluateRoute` in the browser on every drag and get exactly the times the
server will compute when it saves.

---

## Deploying to Vercel

1. Import the repo in Vercel. Framework detection picks up Next.js; no build
   command or output directory overrides are needed.
2. Create the Supabase project and apply the schema — `drizzle/0000_*.sql` is
   committed, or run `npm run db:push` with `DATABASE_URL` set locally.
3. **Set every variable from `.env.example` in Project Settings → Environment
   Variables before the first deploy.** `DATABASE_URL` in particular is not
   optional in production: the JSON file store cannot work on a read-only,
   per-invocation serverless filesystem, so `lib/db/index.ts` throws a
   descriptive error rather than half-writing an upload.
4. Use the **pooled** Supavisor string in transaction mode (port 6543), not the
   direct connection on 5432. Serverless functions need pooling, and transaction
   mode is why the driver sets `prepare: false`.
5. Two different Google keys. `GOOGLE_MAPS_API_KEY` restricted to the Geocoding
   and Routes APIs, no referrer restriction, server-side only.
   `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` restricted to the Maps JavaScript API
   by HTTP referrer — add the Vercel domain once you have it.

### Function duration

Both long-running routes declare `maxDuration = 60`, which is the ceiling on
Vercel's **Hobby** plan. A higher value does not degrade gracefully — the
deployment fails outright. On Pro, raise both to `300`:

- `app/api/upload/route.ts` — parses every job in one call
- `app/api/schedules/[id]/build/route.ts` — geocode, matrix, optimize, suggest

If a 34-job parse times out at 60s on Hobby, that is the fix.

### Running cost

Two Opus calls per Saturday is well under a dollar, and geocoding is cached per
address so it approaches zero after a few weeks.

The distance matrix is the line item to watch. It bills **per element**, and 35
stops is 35 × 35 = 1,225 elements per build. Drag-and-drop reuses the cached
matrix and costs nothing, but **changing the team count rebuilds it**, so
clicking through 8 → 9 → 10 teams is ~3,700 elements in a minute. Set a daily
cap on the Routes API in the Google Cloud console, and check current per-element
pricing before assuming this stays in single digits.

---

## Deliberately not built (v1)

Direct integration with the scheduling app, team-to-house consistency as an
optimizer constraint (the data model supports it; distance and timing win for
now), multi-day scheduling, and anything to do with notifying cleaners, texting,
invoicing or payroll.
