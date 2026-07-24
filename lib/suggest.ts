import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { getClaude, isClaudeConfigured, PARSING_MODEL } from "@/lib/anthropic";
import { SuggestResponseSchema } from "@/lib/parse/schema";
import { to12Hour } from "@/lib/time";
import type { Assignment, EffectiveJob, Override } from "@/lib/types";

/**
 * The second Claude call: which team number should take each computed route,
 * plus a short plain-language rationale.
 *
 * This runs *after* routing and never feeds back into it. Routes are decided by
 * distance and time windows in lib/optimize; this only labels them. The UI tags
 * every suggestion as a suggestion, and the scheduler can override in one tap.
 *
 * The payload deliberately contains no access codes — door codes and lockbox
 * combinations have nothing to do with which team goes where.
 */

export type RouteForSuggestion = {
  routeId: string;
  stops: { houseId: string; customer: string; town: string; arrival: string }[];
};

export type Suggestion = { routeId: string; team: number; rationale: string };

/** The deterministic fallback: number the routes, describe the geography. */
export function fallbackSuggestions(routes: RouteForSuggestion[]): Suggestion[] {
  return routes.map((route, index) => {
    const towns = [...new Set(route.stops.map((s) => s.town))];
    const where =
      towns.length === 1
        ? `${towns[0]}`
        : `${towns.slice(0, -1).join(", ")} and ${towns[towns.length - 1]}`;
    return {
      routeId: route.routeId,
      team: index + 1,
      rationale: `${route.stops.length} ${route.stops.length === 1 ? "stop" : "stops"} in ${where}. Assigned in route order — no assignment history was available to draw on.`,
    };
  });
}

function formatHistory(
  routes: RouteForSuggestion[],
  assignments: Assignment[],
  teamCount: number,
): string {
  const byHouse = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    const list = byHouse.get(assignment.houseId) ?? [];
    list.push(assignment);
    byHouse.set(assignment.houseId, list);
  }

  const lines: string[] = [];
  for (const route of routes) {
    const counts = new Map<number, { count: number; latest: string }>();
    for (const stop of route.stops) {
      for (const assignment of byHouse.get(stop.houseId) ?? []) {
        const existing = counts.get(assignment.team);
        counts.set(assignment.team, {
          count: (existing?.count ?? 0) + 1,
          latest:
            existing && existing.latest > assignment.date ? existing.latest : assignment.date,
        });
      }
    }

    if (counts.size === 0) {
      lines.push(`${route.routeId}: no team has cleaned any of these houses before.`);
      continue;
    }

    const summary = [...counts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .map(([team, info]) => `Team ${team} cleaned ${info.count} of them (most recently ${info.latest})`)
      .join("; ");
    lines.push(`${route.routeId}: ${summary}.`);
  }

  return `Teams available: 1 through ${teamCount}.\n\n${lines.join("\n")}`;
}

function formatOverrides(overrides: Override[]): string {
  if (overrides.length === 0) return "";
  const lines = overrides.slice(0, 25).map((o) => `- ${o.date}: ${o.description}`);
  return `
HOW THE SCHEDULER ACTUALLY SCHEDULES
These are changes he made by hand to recent plans, after the optimizer proposed
something else. Let them pull your suggestions toward his habits.

${lines.join("\n")}
`.trim();
}

const SYSTEM_PROMPT = `
You assign team numbers to already-computed cleaning routes for The Furies, a
Cape Cod cleaning company, and explain each pick in two sentences.

The routes are fixed. They were computed from real drive times and time windows,
and you must not reorder stops, move a job between routes, or comment on whether
the routing is good. Your only decisions are which team number takes each route
and how to explain it.

Base the pick mainly on which teams have cleaned those houses before — a team
that knows a house is faster in it. Do not assign the same team to two routes.
If history gives you nothing for a route, say so plainly rather than inventing a
reason.

Write the rationale for a scheduler in a hurry: name the towns, name the history.
"Route C is the Truro loop; Team 3 did two of these houses last Saturday" is the
right shape and length. No preamble, no hedging.
`.trim();

export async function suggestTeams(
  routes: RouteForSuggestion[],
  assignments: Assignment[],
  overrides: Override[],
  teamCount: number,
): Promise<{ suggestions: Suggestion[]; source: "claude" | "fallback" }> {
  if (routes.length === 0) return { suggestions: [], source: "fallback" };
  if (!isClaudeConfigured()) {
    return { suggestions: fallbackSuggestions(routes), source: "fallback" };
  }

  const routeBlocks = routes
    .map((route) => {
      const stops = route.stops
        .map((s, i) => `  ${i + 1}. ${s.customer} — ${s.town}, arriving ${to12Hour(s.arrival)}`)
        .join("\n");
      return `${route.routeId}\n${stops}`;
    })
    .join("\n\n");

  const userContent = [
    formatOverrides(overrides),
    "THE COMPUTED ROUTES",
    routeBlocks,
    "ASSIGNMENT HISTORY",
    formatHistory(routes, assignments, teamCount),
    `Return one suggestion per route, echoing route_id exactly. Team numbers must be between 1 and ${teamCount}, and each team may appear at most once.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const message = await getClaude().messages.parse({
      model: PARSING_MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low", format: zodOutputFormat(SuggestResponseSchema) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });

    if (message.stop_reason === "refusal" || !message.parsed_output) {
      return { suggestions: fallbackSuggestions(routes), source: "fallback" };
    }

    const byRoute = new Map(message.parsed_output.suggestions.map((s) => [s.route_id, s]));
    const fallback = fallbackSuggestions(routes);
    const usedTeams = new Set<number>();

    const suggestions = routes.map((route, index) => {
      const match = byRoute.get(route.routeId);
      const team = match?.team;
      // Reject an out-of-range or duplicated team rather than showing the
      // scheduler a plan where two routes are both "Team 3".
      const valid =
        typeof team === "number" && team >= 1 && team <= teamCount && !usedTeams.has(team);

      if (!valid) return fallback[index];
      usedTeams.add(team);
      return { routeId: route.routeId, team, rationale: match?.rationale ?? fallback[index].rationale };
    });

    return { suggestions, source: "claude" };
  } catch {
    return { suggestions: fallbackSuggestions(routes), source: "fallback" };
  }
}
