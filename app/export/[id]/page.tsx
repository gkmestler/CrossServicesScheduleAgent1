import { notFound } from "next/navigation";

import { Header } from "@/components/layout/Header";
import { ExportCards, type ExportRoute } from "@/components/screens/ExportCards";
import { getStore } from "@/lib/db";
import { getScheduleDetail } from "@/lib/schedule";
import { requireSession } from "@/lib/session";

export default async function ExportPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();

  const { id } = await params;
  const detail = await getScheduleDetail(id);
  if (!detail) notFound();

  const store = getStore();
  const jobsById = new Map(detail.jobs.map((job) => [job.id, job]));

  // Jobs are never refused a slot, so anything reported here against a stop is
  // a window the plan could not keep. The crew needs to read it.
  const warningByJob = new Map(detail.unschedulable.map((item) => [item.jobId, item.reason]));

  /**
   * This is the one screen where access codes belong: it is what the scheduler
   * reads while typing the plan into the scheduling app, and what a team would
   * be handed as a printed route sheet.
   */
  const routes: ExportRoute[] = detail.routes
    .slice()
    .sort((a, b) => (a.finalTeam ?? a.position) - (b.finalTeam ?? b.position))
    .map((route) => ({
      id: route.id,
      team: route.finalTeam ?? route.suggestedTeam ?? route.position + 1,
      stops: route.stops.map((stop) => {
        const job = jobsById.get(stop.jobId);
        return {
          customer: job?.customer ?? "(job no longer on this schedule)",
          address: job?.address ?? "",
          arrival: stop.estArrival,
          finish: stop.estFinish,
          windowStart: job?.window_start ?? "",
          windowEnd: job?.window_end ?? "",
          pinnedTime: job?.pinned_time ?? null,
          access: job?.access ?? null,
          instructions: job?.instructions ?? null,
          warning: warningByJob.get(stop.jobId) ?? null,
        };
      }),
    }));

  return (
    <>
      <Header storeKind={store.kind} />
      <main id="main" className="mx-auto max-w-[1000px] px-5 py-8 md:px-8 md:py-12">
        <ExportCards
          scheduleId={id}
          date={detail.schedule.date}
          status={detail.schedule.status}
          routes={routes}
        />
      </main>
    </>
  );
}
