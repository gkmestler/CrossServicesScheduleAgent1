"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { Button, Card, StatusLine } from "@/components/ui";

/**
 * Drag-and-drop zone plus a file picker, accepting .csv and .xlsx.
 *
 * Parsing progress shows as a plain status line, not a fake percentage bar —
 * the request either is in flight or it is not, and pretending to know how far
 * along it is would be a lie.
 */
export function UploadZone() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setStatus(`Reading ${file.name}…`);

    const body = new FormData();
    body.append("file", file);

    try {
      setStatus("Reading every job's notes for its arrival window, access details and instructions. This takes a moment.");
      const response = await fetch("/api/upload", { method: "POST", body });

      // A server crash returns an HTML error page, not JSON. Say so rather than
      // swallowing it — an unexplained "that did not work" is worse than useless.
      const raw = await response.text();
      let payload: {
        scheduleId?: string;
        jobCount?: number;
        needsReview?: number;
        error?: string;
      } = {};
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        payload = {
          error:
            response.status === 504
              ? "The upload timed out on the server. On Vercel's Hobby plan a request is cut off at 60 seconds; a large export may need the Pro plan and maxDuration raised to 300."
              : `The server returned an error (HTTP ${response.status}) instead of a result. Check the deployment's Runtime Logs for the cause.`,
        };
      }

      if (!response.ok || !payload.scheduleId) {
        setError(payload.error ?? `That upload did not work (HTTP ${response.status}).`);
        setStatus(null);
        setBusy(false);
        return;
      }

      setStatus(
        `Read ${payload.jobCount} jobs. Opening the review screen${payload.needsReview ? ` — ${payload.needsReview} need a look` : ""}.`,
      );
      router.push(`/review/${payload.scheduleId}`);
    } catch {
      setError("The upload could not reach the server. Check your connection and try again.");
      setStatus(null);
      setBusy(false);
    }
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
      setError(`${file.name} is not a .csv or .xlsx file.`);
      return;
    }
    void upload(file);
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        className={`px-6 py-10 text-center transition-colors ${dragging ? "border-cross-blue bg-cross-blue/5" : ""}`}
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (!busy) handleFiles(e.dataTransfer.files);
          }}
          className="flex flex-col items-center gap-4"
        >
          <p className="text-[19px] text-ink">
            {dragging ? "Drop it here" : "Drag the export here"}
          </p>
          <p className="type-mono text-muted">.csv or .xlsx</p>

          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            onChange={(e) => handleFiles(e.target.files)}
            disabled={busy}
          />

          <Button
            variant="secondary"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            Choose a file
          </Button>
        </div>
      </Card>

      {status ? <StatusLine>{status}</StatusLine> : null}
      {error ? (
        <p role="alert" className="text-[15px] text-warn">
          {error}
        </p>
      ) : null}
    </div>
  );
}
