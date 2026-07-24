"use client";

import { useEffect, useRef, useState } from "react";

import type { BoardJob } from "@/components/screens/board-types";
import { Card } from "@/components/ui";

/**
 * All stops, coloured by route. Pins only — no polylines in v1.
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

declare global {
  interface Window {
    google?: typeof globalThis & { maps?: unknown };
  }
}

export function RouteMap({
  apiKey,
  columns,
  estimated,
}: {
  apiKey: string | null;
  columns: MapColumn[];
  estimated: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!apiKey || !containerRef.current) return;

    let cancelled = false;

    async function load() {
      // Reuse the script if the map has already been toggled on once.
      if (!document.querySelector("script[data-google-maps]")) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey!)}&loading=async&libraries=marker`;
          script.async = true;
          script.dataset.googleMaps = "true";
          script.onload = () => resolve();
          script.onerror = () => reject(new Error("script failed"));
          document.head.appendChild(script);
        }).catch(() => {
          if (!cancelled) setError("The map could not load. Check that the browser key is valid and restricted to this domain.");
        });
      }

      if (cancelled || !containerRef.current) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maps = (window as any).google?.maps;
      if (!maps) {
        setError("The map could not load. Check that the browser key is valid and restricted to this domain.");
        return;
      }

      const points = columns.flatMap((column, index) =>
        column.jobs
          .filter((job) => job.lat !== null && job.lng !== null)
          .map((job) => ({ job, color: ROUTE_COLORS[index % ROUTE_COLORS.length], label: column.label })),
      );

      if (points.length === 0) {
        setError("None of these jobs have coordinates yet.");
        return;
      }

      const map = new maps.Map(containerRef.current, {
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });

      const bounds = new maps.LatLngBounds();
      for (const point of points) {
        const position = { lat: point.job.lat!, lng: point.job.lng! };
        bounds.extend(position);
        new maps.Marker({
          map,
          position,
          title: `${point.label} — ${point.job.customer} (${point.job.town})`,
          icon: {
            path: maps.SymbolPath.CIRCLE,
            scale: 8,
            fillColor: point.color,
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 2,
          },
        });
      }

      map.fitBounds(bounds, 48);
      setReady(true);
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [apiKey, columns]);

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
        {columns.map((column, index) => (
          <span key={column.label + index} className="type-mono flex items-center gap-1.5 text-muted">
            <span
              aria-hidden="true"
              className="inline-block h-3 w-3 rounded-full"
              style={{ background: ROUTE_COLORS[index % ROUTE_COLORS.length] }}
            />
            {column.label}
          </span>
        ))}
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
