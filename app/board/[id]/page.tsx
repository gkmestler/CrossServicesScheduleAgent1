import { notFound } from "next/navigation";

import { Header } from "@/components/layout/Header";
import { Board } from "@/components/screens/Board";
import { getStore } from "@/lib/db";
import { getHomeBaseCoordinate } from "@/lib/home-base";
import { getScheduleDetail } from "@/lib/schedule";
import { requireSession } from "@/lib/session";
import type { BoardJob } from "@/components/screens/board-types";

export default async function BoardPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();

  const { id } = await params;
  const detail = await getScheduleDetail(id);
  if (!detail) notFound();

  const store = getStore();
  const homeBase = await getHomeBaseCoordinate();

  /**
   * The board never receives access codes. It has no use for them, and the
   * fewer places a lockbox combination travels the better. The export view is
   * where they belong.
   */
  const jobs: BoardJob[] = detail.jobs.map((job) => ({
    id: job.id,
    customer: job.customer,
    address: job.address,
    town: job.town,
    windowStart: job.window_start,
    windowEnd: job.window_end,
    pinnedTime: job.pinned_time,
    durationMinutes: job.durationMinutes,
    jobType: job.job_type,
    instructions: job.instructions,
    lat: job.lat,
    lng: job.lng,
  }));

  return (
    <>
      <Header storeKind={store.kind} />
      <main id="main" className="mx-auto max-w-[1600px] px-5 py-8 md:px-8">
        <Board
          scheduleId={id}
          schedule={detail.schedule}
          jobs={jobs}
          routes={detail.routes}
          browserMapKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY ?? null}
          homeBase={homeBase}
        />
      </main>
    </>
  );
}
