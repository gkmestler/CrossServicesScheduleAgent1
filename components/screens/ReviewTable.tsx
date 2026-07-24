"use client";

import { useMemo, useState } from "react";

import { CheckMark, Input, MonoTag, Select, StatusLine, Tag, TextArea } from "@/components/ui";
import { to12Hour, windowLabel } from "@/lib/time";
import type { EffectiveJob, JobType } from "@/lib/types";

/**
 * The review table. Every field is editable inline, and every edit is recorded
 * as a correction (server-side) so a recurring customer stops parsing wrong
 * after one fix.
 *
 * Low-confidence jobs sort to the top with their flag text, because those are
 * the only rows that actually need reading.
 */

const JOB_TYPE_LABELS: Record<JobType, string> = {
  changeover: "Changeover",
  house_cleaning: "House cleaning",
  linens: "Linens",
  other: "Other",
};

/** What a PATCH body may contain: edited text fields, plus the reviewed flag. */
type Draft = Partial<Record<Exclude<keyof EffectiveJob, "confirmed">, string | null>> & {
  confirmed?: boolean;
};

export function ReviewTable({
  scheduleId,
  jobs: initialJobs,
  readOnly = false,
}: {
  scheduleId: string;
  jobs: EffectiveJob[];
  readOnly?: boolean;
}) {
  const [jobs, setJobs] = useState(initialJobs);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);

  const reviewedCount = jobs.filter((job) => job.confirmed).length;
  const allReviewed = jobs.length > 0 && reviewedCount === jobs.length;

  // Low confidence first, then medium, then by town so like sits with like.
  const ordered = useMemo(() => {
    const rank = { low: 0, medium: 1, high: 2 } as const;
    return [...jobs].sort(
      (a, b) => rank[a.confidence] - rank[b.confidence] || a.town.localeCompare(b.town),
    );
  }, [jobs]);

  async function save(jobId: string, patch: Draft) {
    setError(null);
    const response = await fetch(`/api/schedules/${scheduleId}/jobs/${jobId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "That change could not be saved.");
      return false;
    }

    const body = (await response.json()) as { correctionsRecorded: number };
    setStatus(
      body.correctionsRecorded > 0
        ? "Saved. Next week's parse will follow this correction."
        : "Saved.",
    );
    return true;
  }

  function updateLocal(jobId: string, patch: Partial<EffectiveJob>) {
    setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, ...patch } : job)));
  }

  async function commit(job: EffectiveJob, field: keyof EffectiveJob, value: string | null) {
    const previous = job[field];
    const normalized = value === "" ? null : value;
    if (String(previous ?? "") === String(normalized ?? "")) return;

    updateLocal(job.id, { [field]: normalized } as Partial<EffectiveJob>);
    const ok = await save(job.id, { [field]: normalized });
    // Roll the cell back rather than showing a value the server rejected.
    if (!ok) updateLocal(job.id, { [field]: previous } as Partial<EffectiveJob>);
  }

  async function toggleConfirmed(job: EffectiveJob) {
    const next = !job.confirmed;
    updateLocal(job.id, { confirmed: next });
    const ok = await save(job.id, { confirmed: next });
    if (!ok) updateLocal(job.id, { confirmed: !next });
  }

  /**
   * Most Saturdays parse cleanly, so ticking fifty rows one at a time is the
   * tax. Mark the lot reviewed here and untick the few that need arguing with.
   */
  async function toggleAllConfirmed() {
    const next = !allReviewed;
    const previous = jobs;

    setBulkPending(true);
    setError(null);
    setJobs((current) => current.map((job) => ({ ...job, confirmed: next })));

    try {
      const response = await fetch(`/api/schedules/${scheduleId}/jobs`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmed: next }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setJobs(previous);
        setError(body.error ?? "Those rows could not be saved.");
        return;
      }

      setStatus(
        next
          ? `All ${previous.length} ${previous.length === 1 ? "job" : "jobs"} marked reviewed. Untick any that still need a look.`
          : "Cleared. No jobs are marked reviewed.",
      );
    } catch {
      setJobs(previous);
      setError("Those rows could not be saved — the request did not reach the server.");
    } finally {
      setBulkPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {status ? <StatusLine>{status}</StatusLine> : null}
      {error ? (
        <p role="alert" className="text-[15px] text-warn">
          {error}
        </p>
      ) : null}

      {/* Select-all sits above the table rather than in the column header: the
          table scrolls sideways, this line does not. */}
      {jobs.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            disabled={readOnly || bulkPending}
            onClick={() => void toggleAllConfirmed()}
            aria-pressed={allReviewed}
            className="group flex min-h-11 items-center gap-2 text-[17px] text-ink disabled:pointer-events-none disabled:opacity-50"
          >
            <CheckMark checked={allReviewed} indeterminate={reviewedCount > 0 && !allReviewed} />
            {allReviewed ? "Clear all" : "Mark all reviewed"}
          </button>

          <span className="type-mono text-muted">
            {reviewedCount} of {jobs.length} reviewed
          </span>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-[3px] border border-line bg-surface">
        <table className="w-full min-w-[980px] border-collapse text-left">
          <caption className="sr-only">
            Parsed jobs. Low-confidence jobs appear first. Every field is editable.
          </caption>
          <thead>
            <tr className="border-b border-line bg-paper">
              <th scope="col" className="type-eyebrow px-3 py-3 text-muted">
                <span className="sr-only">Confirmed</span>
              </th>
              <th scope="col" className="type-eyebrow px-3 py-3 text-muted">Customer</th>
              <th scope="col" className="type-eyebrow px-3 py-3 text-muted">Town</th>
              <th scope="col" className="type-eyebrow px-3 py-3 text-muted">Window</th>
              <th scope="col" className="type-eyebrow px-3 py-3 text-muted">Pinned</th>
              <th scope="col" className="type-eyebrow px-3 py-3 text-muted">Access</th>
              <th scope="col" className="type-eyebrow px-3 py-3 text-muted">Instructions</th>
              <th scope="col" className="type-eyebrow px-3 py-3 text-muted">Type</th>
            </tr>
          </thead>

          <tbody>
            {ordered.map((job) => (
              <tr key={job.id} className="group border-b border-line align-top last:border-b-0">
                {/* The checkbox mark is the brand signature and genuinely does
                    something here: it marks a row the scheduler has read. */}
                <td className="px-3 py-3">
                  <button
                    type="button"
                    disabled={readOnly || bulkPending}
                    onClick={() => void toggleConfirmed(job)}
                    aria-pressed={job.confirmed}
                    aria-label={`Mark ${job.customer} as reviewed`}
                    className="flex min-h-11 min-w-11 items-center justify-center disabled:opacity-50"
                  >
                    <CheckMark checked={job.confirmed} />
                  </button>
                </td>

                <td className="px-3 py-3">
                  <div className="flex flex-col gap-1.5">
                    <Input
                      defaultValue={job.customer}
                      readOnly={readOnly}
                      aria-label="Customer"
                      className="min-w-[160px]"
                      onBlur={(e) => void commit(job, "customer", e.target.value.trim())}
                    />
                    <Input
                      defaultValue={job.address}
                      readOnly={readOnly}
                      aria-label="Address"
                      className="type-mono min-w-[220px] text-[13px]"
                      onBlur={(e) => void commit(job, "address", e.target.value.trim())}
                    />

                    {job.confidence !== "high" ? (
                      <div className="mt-1 flex flex-col gap-1">
                        <Tag tone={job.confidence === "low" ? "warn" : "default"}>
                          {job.confidence === "low" ? "Needs review" : "Check this"}
                        </Tag>
                        {job.flags.map((flag) => (
                          <p key={flag} className="max-w-[42ch] text-[15px] text-muted">
                            {flag}
                          </p>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </td>

                <td className="px-3 py-3">
                  <span className="type-mono text-muted">{job.town}</span>
                </td>

                <td className="px-3 py-3">
                  <div className="flex items-center gap-1.5">
                    <Input
                      type="time"
                      defaultValue={job.window_start}
                      readOnly={readOnly}
                      aria-label="Window start"
                      className="type-mono w-[110px]"
                      onBlur={(e) => void commit(job, "window_start", e.target.value)}
                    />
                    <span aria-hidden="true" className="text-muted">
                      –
                    </span>
                    <Input
                      type="time"
                      defaultValue={job.window_end}
                      readOnly={readOnly}
                      aria-label="Window end"
                      className="type-mono w-[110px]"
                      onBlur={(e) => void commit(job, "window_end", e.target.value)}
                    />
                  </div>
                  <MonoTag className="mt-1.5">
                    {windowLabel(job.window_start, job.window_end)}
                  </MonoTag>
                </td>

                <td className="px-3 py-3">
                  <Input
                    type="time"
                    defaultValue={job.pinned_time ?? ""}
                    readOnly={readOnly}
                    aria-label="Pinned time"
                    className="type-mono w-[110px]"
                    onBlur={(e) => void commit(job, "pinned_time", e.target.value || null)}
                  />
                  {job.pinned_time ? (
                    <MonoTag tone="blue" className="mt-1.5" title="This job will not be moved.">
                      <PinIcon /> {to12Hour(job.pinned_time)}
                    </MonoTag>
                  ) : null}
                </td>

                {/* Access is masked by default — this is a door code. */}
                <td className="px-3 py-3">
                  {revealed.has(job.id) ? (
                    <TextArea
                      defaultValue={job.access ?? ""}
                      readOnly={readOnly}
                      aria-label="Access information"
                      rows={2}
                      className="type-mono min-w-[180px]"
                      onBlur={(e) => void commit(job, "access", e.target.value.trim() || null)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRevealed((s) => new Set(s).add(job.id))}
                      className="type-mono min-h-11 w-full min-w-[150px] rounded-[2px] border border-line px-3 text-left whitespace-nowrap text-muted hover:border-cross-blue hover:text-cross-blue"
                    >
                      {job.access ? "•••• reveal" : "none — add"}
                    </button>
                  )}
                </td>

                <td className="px-3 py-3">
                  <TextArea
                    defaultValue={job.instructions ?? ""}
                    readOnly={readOnly}
                    aria-label="Special instructions"
                    rows={2}
                    className="min-w-[220px] text-[15px]"
                    onBlur={(e) => void commit(job, "instructions", e.target.value.trim() || null)}
                  />
                </td>

                <td className="px-3 py-3">
                  <Select
                    defaultValue={job.job_type}
                    disabled={readOnly}
                    aria-label="Job type"
                    className="min-w-[150px]"
                    onChange={(e) => void commit(job, "job_type", e.target.value)}
                  >
                    {Object.entries(JOB_TYPE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </Select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PinIcon() {
  return (
    <svg aria-hidden="true" width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.5 1a.5.5 0 0 0-.35.85l.5.5-2.4 3.2-2.6.5a.5.5 0 0 0-.26.85l2.3 2.3-3.4 4.1a.5.5 0 0 0 .71.71l4.1-3.4 2.3 2.3a.5.5 0 0 0 .85-.26l.5-2.6 3.2-2.4.5.5A.5.5 0 0 0 16 7.5l-6-6A.5.5 0 0 0 9.5 1Z" />
    </svg>
  );
}
