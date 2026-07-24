import Link from "next/link";

import { SignOutButton } from "@/components/layout/SignOutButton";

/**
 * Type-only lockup. The logo is a white-background .webp that cannot sit on
 * coloured surfaces, so the image file is deliberately unused (BRAND.md).
 */
export function Header({ storeKind }: { storeKind: "postgres" | "file" }) {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-paper/95 backdrop-blur-sm no-print">
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-5 py-3 md:px-8">
        <Link href="/" className="group flex flex-col gap-0.5">
          <span className="font-display text-[19px] leading-none font-medium text-cross-navy md:text-[22px]">
            Cross Services Group
          </span>
          <span className="type-eyebrow text-muted group-hover:text-cross-blue">
            The Furies Scheduler
          </span>
        </Link>

        <div className="flex items-center gap-3">
          {/* Where the data is going should never be a mystery. */}
          {storeKind === "file" ? (
            <span
              className="type-eyebrow hidden rounded-[2px] border border-line px-2 py-1 text-muted sm:inline-flex"
              title="DATABASE_URL is not set, so schedules are saved to a local .data/scheduler.json file instead of Postgres."
            >
              Local storage
            </span>
          ) : null}
          <SignOutButton />
        </div>
      </div>
    </header>
  );
}
