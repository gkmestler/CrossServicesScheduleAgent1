import { notFound } from "next/navigation";

import { Header } from "@/components/layout/Header";
import { ReviewTable } from "@/components/screens/ReviewTable";
import { ButtonLink, Tag } from "@/components/ui";
import { getStore } from "@/lib/db";
import { getScheduleDetail } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import { formatDateLong } from "@/lib/time";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();

  const { id } = await params;
  const detail = await getScheduleDetail(id);
  if (!detail) notFound();

  const store = getStore();
  const needsReview = detail.jobs.filter((job) => job.confidence === "low").length;

  return (
    <>
      <Header storeKind={store.kind} />

      <main id="main" className="mx-auto max-w-[1200px] px-5 py-8 md:px-8 md:py-12">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] leading-[1.15] font-medium md:text-[34px]">
              {formatDateLong(detail.schedule.date)}
            </h1>
            {/* The count line anchors the screen. */}
            <p className="type-mono mt-2 text-muted">
              {detail.jobs.length} {detail.jobs.length === 1 ? "job" : "jobs"},{" "}
              {needsReview === 0 ? "none need review" : `${needsReview} need review`}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Tag tone={detail.schedule.parseSource === "claude" ? "blue" : "default"}>
              {detail.schedule.parseSource === "claude" ? "AI parsed" : "Rule-based parse"}
            </Tag>
            {detail.schedule.status === "final" ? <Tag tone="solid">Finalized</Tag> : null}
          </div>
        </div>

        {detail.schedule.parseNote ? (
          <p className="mt-4 rounded-[3px] border border-warn/40 bg-warn/8 px-4 py-3 text-[15px] text-ink">
            <span className="font-medium">Parsed without the AI.</span>{" "}
            {detail.schedule.parseNote} Everything below came from the built-in rules, which handle
            the common formats but read fewer of the awkward notes correctly. Worth a closer look
            than usual.
          </p>
        ) : null}

        <div className="mt-8">
          <ReviewTable scheduleId={id} jobs={detail.jobs} readOnly={detail.schedule.status === "final"} />
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <ButtonLink href={`/board/${id}`}>Build schedule</ButtonLink>
          {detail.routes.length > 0 ? (
            <span className="type-mono text-muted">
              A plan already exists for this Saturday — opening the board keeps it.
            </span>
          ) : null}
        </div>
      </main>
    </>
  );
}
