"use client";

import { useEffect, useRef, useState } from "react";

import type { BoardJob } from "@/components/screens/board-types";
import { Button, Card } from "@/components/ui";

/**
 * Every stop, coloured by route, numbered in visiting order and joined by a line
 * that follows the run, with the home base every team works out of. Clicking a
 * team in the legend isolates it.
 *
 * Uses a separate browser-restricted key (NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY),
 * distinct from the server key that does geocoding and distances. Without it the
 * component says so rather than rendering a broken grey box.
 */

type MapColumn = { label: string; jobs: BoardJob[] };

/**
 * Route colours. This is the one place the brand's "no third accent" rule bends,
 * because a map with eight identically-coloured pin sets communicates nothing.
 * The palette stays desaturated so it reads as data, not decoration, and every
 * pin is also labelled with its team number.
 */
const ROUTE_COLORS = [
  "#1255a2", "#8a4b1f", "#3f6b4a", "#6b3f6b", "#0b3665",
  "#7a6a2f", "#2f6b7a", "#7a2f45", "#4a4a4a", "#2f7a5c",
];

/* The Maps JS types are not installed, so the API surface is untyped here. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Maps = any;

const LOAD_FAILED =
  "The map could not load. Check that the browser key is valid and restricted to this domain.";

/** Global hook the Maps loader calls once the API is genuinely usable. */
const READY_CALLBACK = "__furiesMapsReady";

/**
 * One shared loader for the page, awaited by every mount.
 *
 * Two things made the map need a hide-and-show before it appeared. The script
 * was considered loaded the moment a `<script data-google-maps>` tag existed in
 * the DOM, which is long before it has finished fetching — so a second run of
 * the effect in that window skipped the wait and found nothing. React's
 * development double-mount makes that second run happen every time. And under
 * `loading=async`, `script.onload` fires while `google.maps` is still only a
 * bootstrap stub: the namespace is there but `google.maps.Map` is not a
 * constructor yet. Toggling the map off and on "fixed" both only because the
 * real API had finished arriving in the meantime.
 *
 * The `callback` parameter is the documented signal for this — it fires when the
 * legacy namespace is fully populated, so `Map`, `Marker`, `Polyline` and
 * `SymbolPath` are all safe to use from here on.
 */
let loader: Promise<Maps> | null = null;

function loadMaps(apiKey: string): Promise<Maps> {
  if (loader) return loader;

  const pending = new Promise<Maps>((resolve, reject) => {
    (window as any)[READY_CALLBACK] = () => {
      const maps = (window as any).google?.maps;
      if (maps?.Map) resolve(maps);
      else reject(new Error("Maps JavaScript API loaded but did not initialise."));
    };

    const script = document.createElement("script");
    script.src =
      "https://maps.googleapis.com/maps/api/js" +
      `?key=${encodeURIComponent(apiKey)}` +
      `&loading=async&libraries=marker&callback=${READY_CALLBACK}`;
    script.async = true;
    script.onerror = () => reject(new Error("Maps JavaScript API script failed to load."));
    document.head.appendChild(script);
  });

  // A rejected load must not stay cached, or every later retry replays the
  // failure without ever asking the network again.
  pending.catch(() => {
    if (loader === pending) loader = null;
  });

  loader = pending;
  return pending;
}

export function RouteMap({
  apiKey,
  columns,
  estimated,
  homeBase,
}: {
  apiKey: string | null;
  columns: MapColumn[];
  estimated: boolean;
  homeBase: { lat: number; lng: number } | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Maps>(null);
  const overlaysRef = useRef<Maps[]>([]);
  /** Which isolation the viewport was last fitted to; undefined until drawn. */
  const fittedSelectionRef = useRef<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (selected !== null && selected >= columns.length) setSelected(null);
  }, [columns.length, selected]);

  useEffect(() => {
    if (!apiKey) return;

    let cancelled = false;

    async function draw() {
      let maps: Maps;
      try {
        maps = await loadMaps(apiKey!);
      } catch {
        if (!cancelled) setError(LOAD_FAILED);
        return;
      }

      if (cancelled || !containerRef.current) return;

      // Laid out before the isolation filter, not after: colours come from a
      // column's own index, and pins sharing a coordinate are spread against
      // every other stop on the day. Filtering first would recolour the teams
      // and shift the pins as soon as one was isolated.
      const routes = layOut(columns).filter(
        (_, index) => selected === null || index === selected,
      );

      if (routes.every((route) => route.stops.length === 0)) {
        setError(
          selected === null
            ? "None of these jobs have coordinates yet."
            : "This team has no jobs with coordinates yet.",
        );
        return;
      }
      setError(null);

      // Created once and kept. Rebuilding the map on every prop change threw
      // away whatever the user had panned or zoomed to.
      const isFirstDraw = mapRef.current === null;
      if (isFirstDraw) {
        mapRef.current = new maps.Map(containerRef.current, {
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          // Without this fitBounds snaps down to a whole zoom level, which on a
          // day's worth of stops in one town can leave the run as a knot of
          // overlapping pins in the middle of half the state.
          isFractionalZoomEnabled: true,
        });
      }
      const map = mapRef.current;

      for (const overlay of overlaysRef.current) overlay.setMap(null);
      overlaysRef.current = [];

      const bounds = new maps.LatLngBounds();

      for (const route of routes) {
        if (route.stops.length === 0) continue;

        // The run itself, drawn under the pins. Arrows carry the direction, so
        // stop 1 to stop 2 is readable without counting the numbers.
        if (route.stops.length > 1) {
          overlaysRef.current.push(
            new maps.Polyline({
              map,
              path: route.stops.map((stop) => stop.position),
              strokeColor: route.color,
              strokeOpacity: 0.7,
              strokeWeight: 3,
              icons: [
                {
                  icon: {
                    path: maps.SymbolPath.FORWARD_CLOSED_ARROW,
                    scale: 2.6,
                    strokeColor: route.color,
                    strokeOpacity: 1,
                    fillColor: route.color,
                    fillOpacity: 1,
                  },
                  offset: "50%",
                  repeat: "140px",
                },
              ],
            }),
          );
        }

        route.stops.forEach((stop, index) => {
          bounds.extend(stop.position);
          const number = String(index + 1);
          overlaysRef.current.push(
            new maps.Marker({
              map,
              position: stop.position,
              zIndex: 10,
              title: `${route.label} · stop ${number} — ${stop.job.customer} (${stop.job.town})`,
              label: {
                text: number,
                color: "#ffffff",
                fontSize: number.length > 1 ? "10px" : "11px",
                fontWeight: "600",
              },
              icon: {
                path: maps.SymbolPath.CIRCLE,
                scale: 11,
                fillColor: route.color,
                fillOpacity: 1,
                strokeColor: "#ffffff",
                strokeWeight: 2,
              },
            }),
          );
        });
      }

      // Tracked as an overlay like everything else. Left untracked it would
      // survive each redraw and stack a fresh H pin on top of the last one.
      if (homeBase) {
        const position = { lat: homeBase.lat, lng: homeBase.lng };
        bounds.extend(position);
        overlaysRef.current.push(
          new maps.Marker({
            map,
            position,
            title: "Home base — every team starts and ends the day here",
            zIndex: 1000,
            label: { text: "H", color: "#ffffff", fontSize: "11px", fontWeight: "700" },
            icon: {
              path: maps.SymbolPath.CIRCLE,
              scale: 10,
              fillColor: "#1a1a1a",
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
            },
          }),
        );
      }

      // Refit on the first draw, and whenever a team is isolated or released —
      // both change which area matters. Not on a drag or a rebuild, which would
      // yank the viewport away from wherever someone had zoomed to.
      if (isFirstDraw || fittedSelectionRef.current !== selected) {
        fittedSelectionRef.current = selected;
        if (isFirstDraw) {
          // A map that was constructed a moment ago has not been laid out yet,
          // so fitting now measures against the wrong size and leaves the stops
          // pressed into the edges. The first idle is the map saying it knows
          // how big it is.
          maps.event.addListenerOnce(map, "idle", () => map.fitBounds(bounds, 48));
        } else {
          map.fitBounds(bounds, 48);
        }
      }
      setReady(true);
    }

    void draw();
    return () => {
      cancelled = true;
    };
  }, [apiKey, columns, selected, homeBase]);

  if (!apiKey) {
    return (
      <Card className="px-4 py-4">
        <p className="text-[15px] text-muted">
          The map needs <code className="type-mono">NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY</code> — a
          browser-restricted key for the Maps JavaScript API, separate from the server key that does
          geocoding and distances.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        {columns.map((column, index) => {
          const isSelected = selected === index;
          return (
            <button
              key={column.label + index}
              type="button"
              aria-pressed={isSelected}
              onClick={() => setSelected((current) => (current === index ? null : index))}
              className={`type-mono flex items-center gap-1.5 rounded-[2px] px-1.5 py-0.5 ${
                isSelected ? "bg-ink/8 text-ink" : "text-muted"
              }`}
            >
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 rounded-full"
                style={{ background: ROUTE_COLORS[index % ROUTE_COLORS.length] }}
              />
              {column.label}
            </button>
          );
        })}

        {selected !== null ? (
          <Button variant="quiet" size="sm" onClick={() => setSelected(null)}>
            Show all teams
          </Button>
        ) : null}

        <span className="type-mono ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
          {homeBase ? (
            <span className="flex items-center gap-1.5">
              <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full bg-[#1a1a1a]" />
              Home base
            </span>
          ) : null}
          <span>Numbered in visiting order</span>
        </span>
      </div>

      {estimated ? (
        <p className="border-b border-line bg-warn/8 px-4 py-2 text-[15px] text-ink">
          These pins are town-centre estimates, not geocoded addresses — no{" "}
          <code className="type-mono">GOOGLE_MAPS_API_KEY</code> is configured.
        </p>
      ) : null}

      <div ref={containerRef} className="h-[420px] w-full bg-paper" />

      {error ? (
        <p role="alert" className="px-4 py-3 text-[15px] text-warn">
          {error}
        </p>
      ) : !ready ? (
        <p className="px-4 py-3 text-[15px] text-muted">Loading the map…</p>
      ) : null}
    </Card>
  );
}

type PlacedStop = { job: BoardJob; position: { lat: number; lng: number } };
type PlacedRoute = { label: string; color: string; stops: PlacedStop[] };

/**
 * Turns the columns into drawable routes, keeping each column's order — that
 * order is the run, so it is also the numbering and the shape of the line.
 *
 * Stops that share a coordinate get nudged apart. Two jobs at one condo complex
 * — or every job in a town, when coordinates are town-centre estimates — would
 * otherwise stack into a single dot with one number legible out of five. The
 * offset is a few metres on a golden-angle spiral, small enough that the pin is
 * still on the right building and stable enough that a redraw does not shuffle
 * them.
 */
function layOut(columns: MapColumn[]): PlacedRoute[] {
  const seen = new Map<string, number>();

  return columns.map((column, index) => ({
    label: column.label,
    color: ROUTE_COLORS[index % ROUTE_COLORS.length],
    stops: column.jobs
      .filter((job) => job.lat !== null && job.lng !== null)
      .map((job) => {
        const lat = job.lat!;
        const lng = job.lng!;
        const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
        const nth = seen.get(key) ?? 0;
        seen.set(key, nth + 1);

        if (nth === 0) return { job, position: { lat, lng } };

        const angle = nth * 2.399963; // golden angle, so rings fill evenly
        const radius = 0.00028 * Math.sqrt(nth + 1);
        return {
          job,
          position: {
            lat: lat + radius * Math.sin(angle),
            lng: lng + (radius * Math.cos(angle)) / Math.cos((lat * Math.PI) / 180),
          },
        };
      }),
  }));
}
