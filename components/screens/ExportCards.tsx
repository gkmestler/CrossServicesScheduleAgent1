"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button, ButtonLink, Card, MonoTag, Tag } from "@/components/ui";
import { formatDateLong, to12Hour, windowLabel } from "@/lib/time";

/**
 * What the scheduler reads while typing the plan into the scheduling app.
 *
 * One card per team, numbered stops, access info in mono. Two actions per card:
 * copy as plain text, and a print stylesheet that puts one team per page so
 * route sheets can be handed to teams.
 */

export type ExportStop = {
  customer: string;
  address: string;
  arrival: string;
  finish: string;
  windowStart: string;
  windowEnd: string;
  pinnedTime: string | null;
  access: string | null;
  instructions: string | null;
  /** Set when this stop is scheduled outside the customer's window. */
  warning: string | null;
};

export type ExportRoute = { id: string; team: number; stops: ExportStop[] };

function asPlainText(route: ExportRoute, date: string): string {
  const lines = [`Team ${route.team} — ${formatDateLong(date)}`, ""];

  route.stops.forEach((stop, index) => {
    lines.push(`${index + 1}. ${stop.customer}`);
    if (stop.address) lines.push(`   ${stop.address}`);
    lines.push(
      `   Arrive ${to12Hour(stop.arrival)}, finish ${to12Hour(stop.finish)} (window ${windowLabel(stop.windowStart, stop.windowEnd)})`,
    );
    if (stop.pinnedTime) lines.push(`   TIME LOCK: ${to12Hour(stop.pinnedTime)} — do not move`);
    // The crew is the last person who can catch this, so it goes in the copied
    // text too, not just on screen.
    if (stop.warning) lines.push(`   OUTSIDE WINDOW: ${stop.warning}`);
    if (stop.access) lines.push(`   Access: ${stop.access}`);
    if (stop.instructions) lines.push(`   Notes: ${stop.instructions}`);
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

export function ExportCards({
  scheduleId,
  date,
  status,
  routes,
}: {
  scheduleId: string;
  date: string;
  status: "draft" | "final";
  routes: ExportRoute[];
}) {
  const router = useRouter();
  const [copied, setCopied] = useState<string | null>(null);
  const [reopening, setReopening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Finalizing lands here, so this is where someone realises the plan needs one
   * more change. Reopening from this screen saves a trip back to the board to
   * find the same control.
   */
  async function unfinalize() {
    setReopening(true);
    setError(null);

    const response = await fetch(`/api/schedules/${scheduleId}/finalize`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "This schedule could not be reopened.");
      setReopening(false);
      return;
    }

    router.push(`/board/${scheduleId}`);
  }

  async function copy(route: ExportRoute) {
    const text = asPlainText(route, date);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(route.id);
      setTimeout(() => setCopied((current) => (current === route.id ? null : current)), 2500);
    } catch {
      // Clipboard is blocked in some contexts; a textarea fallback keeps the
      // action working rather than silently doing nothing.
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      document.body.removeChild(area);
      setCopied(route.id);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-4 no-print">
        <div>
          <h1 className="font-display text-[26px] leading-[1.15] font-medium md:text-[34px]">
            {formatDateLong(date)}
          </h1>
          <p className="type-mono mt-2 text-muted">
            {routes.length} {routes.length === 1 ? "team" : "teams"} ·{" "}
            {routes.reduce((n, r) => n + r.stops.length, 0)} stops
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {status === "final" ? <Tag tone="solid">Finalized</Tag> : <Tag>Draft</Tag>}
          {status === "final" ? (
            <Button variant="quiet" size="sm" disabled={reopening} onClick={() => void unfinalize()}>
              {reopening ? "Reopening…" : "Unfinalize"}
            </Button>
          ) : null}
          <ButtonLink href={`/board/${scheduleId}`} variant="secondary" size="sm">
            Back to the board
          </ButtonLink>
          <Button variant="quiet" size="sm" onClick={() => window.print()}>
            Print route sheets
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-[15px] text-warn no-print">
          {error}
        </p>
      ) : null}

      <p className="mt-4 max-w-[68ch] text-[15px] text-muted no-print">
        Access codes are shown here because this is the sheet you work from. Printing puts one team
        per page.
      </p>

      {routes.length === 0 ? (
        <Card className="mt-8 px-5 py-6 no-print">
          <p className="text-[17px] text-muted">
            This Saturday has not been routed yet.{" "}
            <Link href={`/board/${scheduleId}`} className="text-cross-blue underline-offset-4 hover:underline">
              Build the schedule
            </Link>{" "}
            first.
          </p>
        </Card>
      ) : (
        <div className="mt-8 flex flex-col gap-6">
          {routes.map((route) => (
            <Card key={route.id} className="print-page px-5 py-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-display text-[22px] leading-tight font-medium text-cross-navy">
                  Team {route.team}
                </h2>
                <div className="flex items-center gap-2 no-print">
                  <span className="type-mono text-muted">
                    {route.stops.length} {route.stops.length === 1 ? "stop" : "stops"}
                  </span>
                  <Button variant="quiet" size="sm" onClick={() => void copy(route)}>
                    {copied === route.id ? "Copied" : "Copy as text"}
                  </Button>
                </div>
              </div>

              <ol className="mt-4 flex flex-col gap-4">
                {route.stops.map((stop, index) => (
                  <li key={`${route.id}-${index}`} className="border-t border-line pt-4 first:border-t-0 first:pt-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <span className="type-mono text-muted">{index + 1}.</span>
                      <span className="text-[19px] font-medium text-ink">{stop.customer}</span>
                      <MonoTag>{to12Hour(stop.arrival)}</MonoTag>
                      <MonoTag tone="blue">
                        window {windowLabel(stop.windowStart, stop.windowEnd)}
                      </MonoTag>
                      {stop.pinnedTime ? (
                        <MonoTag tone="warn">time lock {to12Hour(stop.pinnedTime)}</MonoTag>
                      ) : null}
                    </div>

                    {stop.address ? (
                      <p className="type-mono mt-1 text-muted">{stop.address}</p>
                    ) : null}

                    {stop.warning ? (
                      <p className="mt-2 max-w-[68ch] text-[15px] text-warn">
                        <span className="type-eyebrow mr-2">Outside window</span>
                        {stop.warning}
                      </p>
                    ) : null}

                    {stop.access ? (
                      <p className="type-mono mt-2">
                        <span className="type-eyebrow mr-2 text-muted">Access</span>
                        {stop.access}
                      </p>
                    ) : null}

                    {stop.instructions ? (
                      <p className="mt-2 max-w-[68ch] text-[15px] text-ink">
                        <span className="type-eyebrow mr-2 text-muted">Notes</span>
                        {stop.instructions}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
