"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { RouteMap } from "@/components/screens/RouteMap";
import type { BoardJob } from "@/components/screens/board-types";
import { Button, ButtonLink, Card, MonoTag, Select, StatusLine, Tag } from "@/components/ui";
import { buildContext, evaluateRoute, type EvalContext } from "@/lib/optimize";
import { formatDateLong, formatDuration, to12Hour, toHHMM, toMinutes, windowLabel } from "@/lib/time";
import type { Route, Schedule } from "@/lib/types";

/**
 * The schedule board. One column per team, ordered stops within each column.
 *
 * Every rearrangement recomputes arrival and finish times in the browser using
 * the same pure `evaluateRoute` the server uses, against the drive-time matrix
 * cached at build time — so a drag is instant and never costs a distance API
 * call. The server then re-derives the same times when it saves, so a stale tab
 * can't persist wrong ones.
 */

type Column = {
  routeId: string;
  finalTeam: number | null;
  suggestedTeam: number | null;
  rationale: string | null;
  jobIds: string[];
};

const TRAY = "__tray__";

export function Board({
  scheduleId,
  schedule: initialSchedule,
  jobs,
  routes: initialRoutes,
  browserMapKey,
  homeBase,
}: {
  scheduleId: string;
  schedule: Schedule;
  jobs: BoardJob[];
  routes: Route[];
  browserMapKey: string | null;
  homeBase: { lat: number; lng: number } | null;
}) {
  const jobsById = useMemo(() => new Map(jobs.map((job) => [job.id, job])), [jobs]);

  /**
   * The schedule is state, not just a prop, because rebuilding the routes and
   * unfinalizing both change it without leaving the page.
   */
  const [schedule, setSchedule] = useState<Schedule>(initialSchedule);
  const [columns, setColumns] = useState<Column[]>(() => toColumns(initialRoutes));
  const [tray, setTray] = useState<string[]>(() => toTray(initialRoutes, jobs));

  // Columns are stored keyed by route, but always displayed in team order
  // (1, 2, 3…) rather than whatever order the optimizer built them in.
  const orderedColumns = useMemo(
    () =>
      columns
        .map((column, index) => ({ column, index }))
        .sort((a, b) => {
          const rankA = a.column.finalTeam ?? a.column.suggestedTeam ?? Infinity;
          const rankB = b.column.finalTeam ?? b.column.suggestedTeam ?? Infinity;
          return rankA - rankB || a.index - b.index;
        })
        .map(({ column }) => column),
    [columns],
  );

  const [movedJobIds, setMovedJobIds] = useState<Set<string>>(new Set());
  const [teamCount, setTeamCount] = useState(schedule.teamCount);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMap, setShowMap] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /** Built once from the cached matrix; drags never touch the network. */
  const ctx: EvalContext | null = useMemo(() => {
    if (!schedule.matrix) return null;
    const ordered = schedule.matrix.jobIds
      .map((id) => jobsById.get(id))
      .filter((job): job is BoardJob => job !== undefined);
    const depotMinutes = schedule.matrix.depotMinutes
      ? new Map(schedule.matrix.jobIds.map((id, i) => [id, schedule.matrix!.depotMinutes![i]]))
      : undefined;
    return buildContext(
      ordered.map((job) => ({
        id: job.id,
        town: job.town,
        lat: job.lat ?? 0,
        lng: job.lng ?? 0,
        windowStart: toMinutes(job.windowStart),
        windowEnd: toMinutes(job.windowEnd),
        pinnedTime: job.pinnedTime ? toMinutes(job.pinnedTime) : null,
        durationMinutes: job.durationMinutes,
      })),
      schedule.matrix.minutes,
      depotMinutes,
    );
  }, [schedule.matrix, jobsById]);

  const evaluations = useMemo(() => {
    if (!ctx) return new Map<string, ReturnType<typeof evaluateRoute>>();
    return new Map(columns.map((column) => [column.routeId, evaluateRoute(column.jobIds, ctx)]));
  }, [columns, ctx]);

  const totalDrive = useMemo(
    () => [...evaluations.values()].reduce((sum, e) => sum + e.driveMinutes, 0),
    [evaluations],
  );

  const violationCount = useMemo(
    () => [...evaluations.values()].reduce((n, e) => n + e.stops.filter((s) => s.violation).length, 0),
    [evaluations],
  );

  /**
   * Memoized because the map redraws whenever this changes identity. Built
   * inline in the JSX it was a new array on every render, so every keystroke
   * elsewhere on the board tore down and rebuilt every pin and line.
   *
   * Ordered the same way as the board columns, so the colour a team has in the
   * legend is the colour it has on the map and the two cannot drift apart.
   */
  const mapColumns = useMemo(
    () =>
      orderedColumns.map((column, index) => ({
        label: labelFor(column, index),
        jobs: column.jobIds
          .map((id) => jobsById.get(id))
          .filter((job): job is BoardJob => job !== undefined),
      })),
    [orderedColumns, jobsById],
  );

  /* ------------------------------------------------------------------ saving */

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const save = useCallback(
    (nextColumns: Column[], nextMoved: Set<string>) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(async () => {
        setError(null);
        setStatus("Saving…");
        const response = await fetch(`/api/schedules/${scheduleId}/routes`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            routes: nextColumns.map((column) => ({
              id: column.routeId,
              finalTeam: column.finalTeam,
              jobIds: column.jobIds,
              movedJobIds: [...nextMoved],
            })),
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? "That change could not be saved.");
          setStatus(null);
          return;
        }
        setStatus("Saved.");
      }, 600);
    },
    [scheduleId],
  );

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
  }, []);

  function applyMove(jobId: string, toRouteId: string, toIndex: number | null) {
    setColumns((current) => {
      const next = current.map((column) => ({
        ...column,
        jobIds: column.jobIds.filter((id) => id !== jobId),
      }));

      if (toRouteId !== TRAY) {
        const target = next.find((column) => column.routeId === toRouteId);
        if (target) {
          const index = toIndex === null ? target.jobIds.length : Math.min(toIndex, target.jobIds.length);
          target.jobIds.splice(index, 0, jobId);
        }
      }

      const moved = new Set(movedJobIds).add(jobId);
      setMovedJobIds(moved);
      save(next, moved);
      return next;
    });

    setTray((current) =>
      toRouteId === TRAY
        ? current.includes(jobId)
          ? current
          : [...current, jobId]
        : current.filter((id) => id !== jobId),
    );
  }

  function reorderWithin(routeId: string, jobId: string, delta: number) {
    setColumns((current) => {
      const next = current.map((column) => ({ ...column, jobIds: [...column.jobIds] }));
      const column = next.find((c) => c.routeId === routeId);
      if (!column) return current;
      const from = column.jobIds.indexOf(jobId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= column.jobIds.length) return current;
      [column.jobIds[from], column.jobIds[to]] = [column.jobIds[to], column.jobIds[from]];

      const moved = new Set(movedJobIds).add(jobId);
      setMovedJobIds(moved);
      save(next, moved);
      return next;
    });
  }

  function setTeam(routeId: string, team: number) {
    setColumns((current) => {
      const next = current.map((column) =>
        column.routeId === routeId ? { ...column, finalTeam: team } : column,
      );
      save(next, movedJobIds);
      return next;
    });
  }

  async function rebuild(nextTeamCount: number) {
    setBusy(true);
    setError(null);
    setStatus("Rebuilding the routes…");

    // A queued autosave holds the routes that are about to be replaced. Letting
    // it fire after the rebuild would write the old grouping back over the new.
    if (saveTimer.current) clearTimeout(saveTimer.current);

    const response = await fetch(`/api/schedules/${scheduleId}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teamCount: nextTeamCount }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      schedule?: Schedule;
      routes?: Route[];
    };

    if (!response.ok || !body.schedule || !body.routes) {
      setError(body.error ?? "The rebuild did not work.");
      setBusy(false);
      setStatus(null);
      return;
    }

    // A rebuild replaces routes, stop times and the cached matrix wholesale, so
    // the board takes the whole new plan from the response. This used to reload
    // the page instead, which meant the map only caught up on a manual refresh.
    setSchedule(body.schedule);
    setColumns(toColumns(body.routes));
    setTray(toTray(body.routes, jobs));
    setMovedJobIds(new Set());
    setTeamCount(body.schedule.teamCount);
    setBusy(false);
    setStatus(
      `Rebuilt into ${body.routes.length} ${body.routes.length === 1 ? "route" : "routes"}.`,
    );
  }

  /** Reopens a finalized schedule for editing. */
  async function unfinalize() {
    setBusy(true);
    setError(null);
    setStatus("Reopening this schedule…");

    const response = await fetch(`/api/schedules/${scheduleId}/finalize`, { method: "DELETE" });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "This schedule could not be reopened.");
      setBusy(false);
      setStatus(null);
      return;
    }

    setSchedule((current) => ({ ...current, status: "draft", finalizedAt: null }));
    setBusy(false);
    setStatus("Back to draft. Finalize again once the changes are in.");
  }

  async function finalize() {
    setBusy(true);
    setError(null);
    setStatus("Saving this plan to history…");
    // Flush any pending autosave first, so history records what is on screen.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    await fetch(`/api/schedules/${scheduleId}/routes`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routes: columns.map((column) => ({
          id: column.routeId,
          finalTeam: column.finalTeam,
          jobIds: column.jobIds,
          movedJobIds: [...movedJobIds],
        })),
      }),
    });

    const response = await fetch(`/api/schedules/${scheduleId}/finalize`, { method: "POST" });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Finalizing did not work.");
      setBusy(false);
      setStatus(null);
      return;
    }
    window.location.href = `/export/${scheduleId}`;
  }

  const readOnly = schedule.status === "final";

  /* ------------------------------------------------------------- not built yet */

  // Reads from state, not the prop, so the first build swaps the prompt for the
  // board in place rather than waiting for a reload.
  if (columns.length === 0) {
    return (
      <BuildPrompt
        date={schedule.date}
        busy={busy}
        error={error}
        status={status}
        onBuild={() => void rebuild(teamCount)}
      />
    );
  }

  return (
    <>
      {/* Above the board: date, team count, total drive time. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[26px] leading-[1.15] font-medium md:text-[34px]">
            {formatDateLong(schedule.date)}
          </h1>
          {/* Driving is what decides the grouping and the order, but it is not
              in the arrival times — stops run back to back. Saying so here stops
              the two numbers looking like they disagree. */}
          <p className="type-mono mt-2 text-muted">
            {jobs.length} jobs · {formatDuration(totalDrive)} driving, not counted in the times
            {schedule.distanceSource === "haversine" ? " (straight-line estimate)" : ""}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="type-eyebrow text-muted">Teams</span>
            <Select
              value={teamCount}
              disabled={busy || readOnly}
              className="w-[80px]"
              onChange={(e) => {
                const next = Number(e.target.value);
                setTeamCount(next);
                void rebuild(next);
              }}
            >
              {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>

          <Button variant="quiet" size="sm" onClick={() => setShowMap((v) => !v)}>
            {showMap ? "Hide map" : "Show map"}
          </Button>

          <ButtonLink href={`/export/${scheduleId}`} variant="secondary" size="sm">
            Export view
          </ButtonLink>

          {!readOnly ? (
            <Button size="sm" disabled={busy} onClick={() => void finalize()}>
              Finalize schedule
            </Button>
          ) : (
            <>
              <Tag tone="solid">Finalized</Tag>
              <Button variant="quiet" size="sm" disabled={busy} onClick={() => void unfinalize()}>
                Unfinalize
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {status ? <StatusLine>{status}</StatusLine> : null}
        {error ? (
          <p role="alert" className="text-[15px] text-warn">
            {error}
          </p>
        ) : null}
        {violationCount > 0 ? (
          <StatusLine tone="warn">
            <WarnIcon /> {violationCount} {violationCount === 1 ? "stop is" : "stops are"} outside
            their window.
          </StatusLine>
        ) : null}
      </div>

      {showMap ? (
        <div className="mt-6">
          <RouteMap
            apiKey={browserMapKey}
            homeBase={homeBase}
            columns={mapColumns}
            estimated={schedule.distanceSource === "haversine"}
          />
        </div>
      ) : null}

      {/* Unschedulable / set-aside tray, clearly separated from the board. */}
      {tray.length > 0 ? (
        <Card className="mt-6 border-warn/40 bg-warn/5 px-4 py-4">
          <h2 className="font-display text-[22px] leading-tight font-medium text-cross-navy">
            <WarnIcon /> Not on any team
          </h2>
          {/* One line about the tray as a whole. Each card carries its own
              reason underneath — showing one job's reason up here made it look
              like the explanation for all of them. */}
          <p className="mt-1 max-w-[68ch] text-[15px] text-muted">
            {tray.length === 1 ? "This job is" : `These ${tray.length} jobs are`} not scheduled for
            anyone. Drop one onto a team, or use its Move control.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {tray.map((jobId) => {
              const job = jobsById.get(jobId);
              if (!job) return null;
              const reason = schedule.unschedulable.find((u) => u.jobId === jobId)?.reason;
              return (
                <li key={jobId}>
                  <div
                    draggable={!readOnly}
                    onDragStart={() => setDragging(jobId)}
                    onDragEnd={() => setDragging(null)}
                    className={`rounded-[2px] border border-line bg-surface px-3 py-2 ${dragging === jobId ? "dragging" : ""}`}
                  >
                    <p className="text-[15px] font-medium text-ink">{job.customer}</p>
                    <p className="type-mono text-muted">
                      {job.town} · {windowLabel(job.windowStart, job.windowEnd)}
                    </p>
                    {reason ? <p className="mt-1 max-w-[36ch] text-[15px] text-warn">{reason}</p> : null}
                    {!readOnly ? (
                      <MoveControl
                        columns={orderedColumns}
                        currentRouteId={null}
                        onMove={(routeId) => applyMove(jobId, routeId, null)}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {/* The board. Horizontally scrolling columns; on small screens each column
          is a swipeable, snapping card. */}
      <div className="hide-scrollbar mt-6 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 md:snap-none">
        {orderedColumns.map((column, index) => {
          const evaluation = evaluations.get(column.routeId);
          const lateStops = evaluation?.stops.filter((stop) => stop.violation).length ?? 0;
          const isDropTarget = dropTarget === column.routeId;

          return (
            <section
              key={column.routeId}
              onDragOver={(e) => {
                if (readOnly || !dragging) return;
                e.preventDefault();
                setDropTarget(column.routeId);
              }}
              onDragLeave={() => setDropTarget((t) => (t === column.routeId ? null : t))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                if (readOnly || !dragging) return;
                applyMove(dragging, column.routeId, null);
                setDragging(null);
              }}
              className={`flex w-[85vw] shrink-0 snap-start flex-col rounded-[3px] border border-line bg-surface sm:w-[340px] ${isDropTarget ? "drop-target" : ""}`}
            >
              <header className="border-b border-line px-4 py-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2">
                    <span className="type-eyebrow text-muted">Team</span>
                    <Select
                      value={column.finalTeam ?? ""}
                      disabled={readOnly}
                      className="w-[76px]"
                      aria-label={`Team for ${labelFor(column, index)}`}
                      onChange={(e) => setTeam(column.routeId, Number(e.target.value))}
                    >
                      {Array.from({ length: teamCount }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </Select>
                  </label>
                  <span
                    className="type-mono text-muted"
                    title="Driving between these stops. Not included in the arrival times."
                  >
                    {column.jobIds.length} {column.jobIds.length === 1 ? "stop" : "stops"}
                    {evaluation ? ` · ${Math.round(evaluation.driveMinutes)} min driving` : ""}
                  </span>
                </div>

                {lateStops > 0 ? (
                  <p className="mt-2 text-[15px] text-warn">
                    <WarnIcon /> {lateStops} {lateStops === 1 ? "stop runs" : "stops run"} outside
                    the window.
                  </p>
                ) : null}

                {column.rationale ? (
                  <div className="mt-2 flex flex-col gap-1">
                    {column.suggestedTeam !== null ? (
                      <Tag tone={column.finalTeam === column.suggestedTeam ? "blue" : "default"}>
                        Suggested: Team {column.suggestedTeam}
                      </Tag>
                    ) : null}
                    <p className="text-[15px] text-muted">{column.rationale}</p>
                  </div>
                ) : null}
              </header>

              <ol className="flex flex-1 flex-col gap-2 p-3">
                {column.jobIds.map((jobId, stopIndex) => {
                  const job = jobsById.get(jobId);
                  const stop = evaluation?.stops[stopIndex];
                  if (!job) return null;

                  return (
                    <li key={jobId}>
                      <div
                        draggable={!readOnly}
                        onDragStart={() => setDragging(jobId)}
                        onDragEnd={() => setDragging(null)}
                        onDragOver={(e) => {
                          if (readOnly || !dragging) return;
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setDropTarget(null);
                          if (readOnly || !dragging || dragging === jobId) return;
                          applyMove(dragging, column.routeId, stopIndex);
                          setDragging(null);
                        }}
                        className={`rounded-[2px] border border-line bg-paper px-3 py-3 ${dragging === jobId ? "dragging" : ""}`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-[17px] font-medium text-ink">
                              {stopIndex + 1}. {job.customer}
                            </p>
                            <p className="type-mono truncate text-muted" title={job.address}>
                              {shortAddress(job.address)} · {job.town}
                            </p>
                          </div>
                          {job.pinnedTime ? (
                            <span title={`Time lock at ${to12Hour(job.pinnedTime)}`} className="shrink-0 text-cross-blue">
                              <PinIcon />
                            </span>
                          ) : null}
                        </div>

                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {stop ? (
                            <MonoTag tone={stop.violation ? "warn" : "default"}>
                              {stop.violation ? <WarnIcon /> : null}
                              {to12Hour(toHHMM(stop.arrival))}–{to12Hour(toHHMM(stop.finish))}
                            </MonoTag>
                          ) : null}
                          <MonoTag tone="blue" title="Customer's arrival window">
                            {windowLabel(job.windowStart, job.windowEnd)}
                          </MonoTag>
                        </div>

                        {/* Colour never carries this alone: icon plus words. */}
                        {stop?.violation ? (
                          <p className="mt-2 text-[15px] text-warn">
                            <WarnIcon /> {stop.violation}
                          </p>
                        ) : null}

                        {!readOnly ? (
                          <div className="mt-2 flex flex-wrap items-center gap-1">
                            <IconButton
                              label={`Move ${job.customer} earlier`}
                              disabled={stopIndex === 0}
                              onClick={() => reorderWithin(column.routeId, jobId, -1)}
                            >
                              ↑
                            </IconButton>
                            <IconButton
                              label={`Move ${job.customer} later`}
                              disabled={stopIndex === column.jobIds.length - 1}
                              onClick={() => reorderWithin(column.routeId, jobId, 1)}
                            >
                              ↓
                            </IconButton>
                            <MoveControl
                              columns={orderedColumns}
                              currentRouteId={column.routeId}
                              onMove={(routeId) => applyMove(jobId, routeId, null)}
                            />
                          </div>
                        ) : null}
                      </div>
                    </li>
                  );
                })}

                {column.jobIds.length === 0 ? (
                  <li className="rounded-[2px] border border-dashed border-line px-3 py-6 text-center text-[15px] text-muted">
                    No stops. Drop a job here.
                  </li>
                ) : null}
              </ol>
            </section>
          );
        })}
      </div>

      <p className="mt-2 text-[15px] text-muted md:hidden">
        Swipe sideways for the other teams. Use ↑ ↓ and Move to rearrange.
      </p>

      <div className="mt-8">
        <Link href={`/review/${scheduleId}`} className="text-cross-blue underline-offset-4 hover:underline">
          Back to the parsed jobs
        </Link>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */

function labelFor(column: Column, index: number): string {
  return column.finalTeam !== null ? `Team ${column.finalTeam}` : `Route ${index + 1}`;
}

/** Server routes to board columns. Used for the initial load and every rebuild. */
function toColumns(routes: Route[]): Column[] {
  return routes.map((route) => ({
    routeId: route.id,
    finalTeam: route.finalTeam,
    suggestedTeam: route.suggestedTeam,
    rationale: route.suggestionRationale,
    jobIds: route.stops.map((stop) => stop.jobId),
  }));
}

/** Whatever the optimizer could not place. Recomputed alongside the columns. */
function toTray(routes: Route[], jobs: BoardJob[]): string[] {
  const placed = new Set(routes.flatMap((route) => route.stops.map((stop) => stop.jobId)));
  return jobs.filter((job) => !placed.has(job.id)).map((job) => job.id);
}

/** Street line only — the town is shown next to it. */
function shortAddress(address: string): string {
  return address.split(",")[0]?.trim() || address;
}

/** Works on touch and with a keyboard, which HTML5 drag-and-drop does not. */
function MoveControl({
  columns,
  currentRouteId,
  onMove,
}: {
  columns: Column[];
  currentRouteId: string | null;
  onMove: (routeId: string) => void;
}) {
  return (
    <Select
      value=""
      aria-label="Move this job to another team"
      className="min-h-11 w-[112px] text-[15px]"
      onChange={(e) => {
        if (e.target.value) onMove(e.target.value);
        e.target.value = "";
      }}
    >
      <option value="">Move…</option>
      {columns
        .filter((column) => column.routeId !== currentRouteId)
        .map((column, index) => (
          <option key={column.routeId} value={column.routeId}>
            {labelFor(column, index)}
          </option>
        ))}
      {currentRouteId !== null ? <option value={TRAY}>Set aside</option> : null}
    </Select>
  );
}

function IconButton({
  children,
  label,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-11 w-11 items-center justify-center rounded-[2px] border border-line bg-surface text-ink hover:border-cross-blue hover:text-cross-blue disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function WarnIcon() {
  return (
    <svg
      aria-hidden="true"
      className="mr-1 inline-block align-[-1px]"
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M8 1.5a.9.9 0 0 1 .78.45l6.1 10.6A.9.9 0 0 1 14.1 14H1.9a.9.9 0 0 1-.78-1.45l6.1-10.6A.9.9 0 0 1 8 1.5Zm0 4a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5.5Zm0 5.25a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 1a.5.5 0 0 0-.35.85l.5.5-2.4 3.2-2.6.5a.5.5 0 0 0-.26.85l2.3 2.3-3.4 4.1a.5.5 0 0 0 .71.71l4.1-3.4 2.3 2.3a.5.5 0 0 0 .85-.26l.5-2.6 3.2-2.4.5.5A.5.5 0 0 0 16 7.5l-6-6A.5.5 0 0 0 9.5 1Z" />
    </svg>
  );
}

function BuildPrompt({
  date,
  busy,
  error,
  status,
  onBuild,
}: {
  date: string;
  busy: boolean;
  error: string | null;
  status: string | null;
  onBuild: () => void;
}) {
  return (
    <div className="mx-auto max-w-[640px] py-10">
      <h1 className="font-display text-[26px] leading-[1.15] font-medium md:text-[34px]">
        {formatDateLong(date)}
      </h1>
      <p className="mt-3 max-w-[68ch] text-[17px] text-muted">
        Nothing has been routed for this Saturday yet. Building it geocodes every address, works out
        real drive times between them, and groups the jobs into team runs that keep each team
        geographically tight and inside every window.
      </p>
      <div className="mt-6 flex flex-col gap-3">
        <Button disabled={busy} onClick={onBuild}>
          {busy ? "Building…" : "Build the routes"}
        </Button>
        {status ? <StatusLine>{status}</StatusLine> : null}
        {error ? (
          <p role="alert" className="text-[15px] text-warn">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
