import { Header } from "@/components/layout/Header";
import { ScheduleList } from "@/components/screens/ScheduleList";
import { UploadZone } from "@/components/screens/UploadZone";
import { Card } from "@/components/ui";
import { getStore } from "@/lib/db";
import { requireSession } from "@/lib/session";

export default async function UploadPage() {
  await requireSession();

  const store = getStore();
  const schedules = await store.listSchedules(12);

  return (
    <>
      <Header storeKind={store.kind} />

      <main id="main" className="mx-auto max-w-[860px] px-5 py-10 md:px-8 md:py-16">
        <h1 className="font-display text-[34px] leading-[1.05] font-medium md:text-[48px]">
          Upload this Saturday&rsquo;s export
        </h1>
        <p className="mt-3 max-w-[68ch] text-[17px] text-muted">
          Drop in the .csv or .xlsx the scheduling app gives you. Every job gets read for its real
          arrival window, access details and instructions, then routed into team runs that stay
          geographically tight.
        </p>

        <div className="mt-8">
          <UploadZone />
        </div>

        <section className="mt-14">
          <h2 className="font-display text-[26px] leading-[1.15] font-medium md:text-[34px]">
            Recent Saturdays
          </h2>

          {schedules.length === 0 ? (
            <EmptyState />
          ) : (
            <ScheduleList
              schedules={schedules.map((schedule) => ({
                id: schedule.id,
                date: schedule.date,
                status: schedule.status,
                teamCount: schedule.teamCount,
                totalDriveMinutes: schedule.totalDriveMinutes,
              }))}
            />
          )}
        </section>
      </main>
    </>
  );
}

/**
 * First run. The one place the brand's strike-through personality is allowed —
 * working screens stay quiet.
 */
function EmptyState() {
  const steps = [
    "Upload the export",
    "Review what was read from the notes",
    "Get the schedule",
  ];

  return (
    <Card className="mt-5 px-5 py-6">
      <p className="text-[17px] text-muted">
        Nothing here yet. Once you upload your first export it will show up in this list, along with
        every Saturday after it.
      </p>

      <ul className="mt-5 flex flex-col gap-3">
        {steps.map((step, index) => (
          <li key={step} className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[2px] border border-cross-blue bg-cross-blue text-white"
            >
              <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2 7.5 5.5 11 12 3.5" />
              </svg>
            </span>
            <span className="relative text-[17px] text-ink">
              {step}
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 -left-1 h-[10px] w-[calc(100%+8px)] -translate-y-1/2 overflow-visible"
                viewBox="0 0 200 10"
                preserveAspectRatio="none"
              >
                <path
                  className="strike-path"
                  style={{ ["--strike-length" as string]: "210", ["--strike-delay" as string]: `${index * 240 + 200}ms` }}
                  d="M2 6 Q 50 3, 100 5.5 T 198 4"
                  stroke="var(--cross-blue)"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
