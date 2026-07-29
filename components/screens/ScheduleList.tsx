"use client";

import Link from "next/link";
import { useState } from "react";

import { Button, Card, Tag } from "@/components/ui";
import { formatDateLong } from "@/lib/time";

/**
 * Recent Saturdays, each row a link into wherever that schedule left off, with
 * a delete control.
 *
 * Deleting takes two taps rather than a browser confirm dialog: the row turns
 * into its own question, so the thing being deleted stays on screen and named
 * while the choice is made.
 */

export type ScheduleSummary = {
  id: string;
  date: string;
  status: "draft" | "final";
  teamCount: number;
  totalDriveMinutes: number | null;
};

export function ScheduleList({ schedules }: { schedules: ScheduleSummary[] }) {
  const [rows, setRows] = useState(schedules);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string) {
    setBusy(id);
    setError(null);

    const response = await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "That schedule could not be deleted.");
      setBusy(null);
      return;
    }

    setRows((current) => current.filter((row) => row.id !== id));
    setConfirming(null);
    setBusy(null);
  }

  if (rows.length === 0) {
    return (
      <Card className="mt-5 px-5 py-6">
        <p className="text-[17px] text-muted">
          Every Saturday here has been deleted. Upload an export to start again.
        </p>
      </Card>
    );
  }

  return (
    <>
      {error ? (
        <p role="alert" className="mt-3 text-[15px] text-warn">
          {error}
        </p>
      ) : null}

      <ul className="mt-5 flex flex-col gap-2">
        {rows.map((schedule) => (
          <Card as="li" key={schedule.id} className={confirming === schedule.id ? "" : "card-lift"}>
            {confirming === schedule.id ? (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[17px] font-medium text-ink">
                    Delete {formatDateLong(schedule.date)}?
                  </span>
                  {/* Says what actually goes, because the houses and door codes
                      surviving is the part that is not obvious. */}
                  <span className="text-[15px] text-muted">
                    Its jobs and routes go for good. Addresses, customers and their saved notes stay.
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={busy === schedule.id}
                    onClick={() => setConfirming(null)}
                  >
                    Keep it
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy === schedule.id}
                    className="bg-warn! hover:bg-warn/85!"
                    onClick={() => void remove(schedule.id)}
                  >
                    {busy === schedule.id ? "Deleting…" : "Delete"}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
                <Link
                  href={schedule.status === "final" ? `/export/${schedule.id}` : `/review/${schedule.id}`}
                  className="flex flex-1 flex-wrap items-center justify-between gap-3"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-[17px] font-medium text-ink">
                      {formatDateLong(schedule.date)}
                    </span>
                    <span className="type-mono text-muted">
                      {schedule.teamCount} teams
                      {schedule.totalDriveMinutes !== null
                        ? ` · ${Math.round(schedule.totalDriveMinutes)} min driving`
                        : " · not routed yet"}
                    </span>
                  </div>
                  <Tag tone={schedule.status === "final" ? "blue" : "default"}>
                    {schedule.status === "final" ? "Finalized" : "Draft"}
                  </Tag>
                </Link>

                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={`Delete ${formatDateLong(schedule.date)}`}
                  onClick={() => {
                    setError(null);
                    setConfirming(schedule.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            )}
          </Card>
        ))}
      </ul>
    </>
  );
}
