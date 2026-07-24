import Link from "next/link";
import type { ComponentPropsWithoutRef, ReactNode } from "react";

/**
 * The complete set of UI primitives. No component library (BRAND.md hard no),
 * so this is the whole vocabulary: button, input, select, card, tag, checkbox
 * mark, field. Everything else composes these.
 */

/* -------------------------------------------------------------------------- */
/* Button                                                                     */
/* -------------------------------------------------------------------------- */

type Variant = "primary" | "secondary" | "tertiary" | "quiet";
type Size = "md" | "sm";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-[2px] font-medium " +
  "transition-colors duration-150 disabled:opacity-50 disabled:pointer-events-none " +
  "leading-none";

const buttonSizes: Record<Size, string> = {
  // 48px tall — comfortably over the 44px tap-target minimum.
  md: "min-h-12 px-6 py-3 text-[17px]",
  sm: "min-h-11 px-4 py-2 text-[15px]",
};

const buttonVariants: Record<Variant, string> = {
  primary: "bg-cross-blue text-white hover:bg-cross-blue-hover",
  secondary: "border border-cross-blue text-cross-blue bg-transparent hover:bg-cross-blue/8",
  tertiary: "text-cross-blue px-0 underline-offset-4 hover:underline decoration-1",
  quiet: "border border-line text-muted bg-surface hover:border-cross-blue hover:text-cross-blue",
};

export function Button({
  children,
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: {
  children: ReactNode;
  variant?: Variant;
  size?: Size;
} & ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type={type}
      className={`${buttonBase} ${buttonSizes[size]} ${buttonVariants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  children,
  href,
  variant = "primary",
  size = "md",
  className = "",
}: {
  children: ReactNode;
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`${buttonBase} ${buttonSizes[size]} ${buttonVariants[variant]} ${className}`}
    >
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return <Tag className={`rounded-[3px] border border-line bg-surface ${className}`}>{children}</Tag>;
}

/* -------------------------------------------------------------------------- */
/* Tag                                                                        */
/* -------------------------------------------------------------------------- */

export function Tag({
  children,
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  tone?: "default" | "blue" | "warn" | "solid";
  className?: string;
}) {
  const tones = {
    default: "border-line bg-paper text-muted",
    blue: "border-cross-blue/25 bg-cross-blue/8 text-cross-blue",
    // Colour is never the only signal — callers pair this with an icon and words.
    warn: "border-warn/40 bg-warn/8 text-warn",
    solid: "border-cross-navy bg-cross-navy text-white",
  } as const;

  return (
    <span
      className={`type-eyebrow inline-flex items-center gap-1 rounded-[2px] border px-2 py-1 ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Mono tag for times, windows and codes — data, not labels. */
export function MonoTag({
  children,
  tone = "default",
  className = "",
  title,
}: {
  children: ReactNode;
  tone?: "default" | "blue" | "warn";
  className?: string;
  title?: string;
}) {
  const tones = {
    default: "border-line bg-paper text-ink",
    blue: "border-cross-blue/25 bg-cross-blue/8 text-cross-blue",
    warn: "border-warn/40 bg-warn/8 text-warn",
  } as const;

  return (
    <span
      title={title}
      className={`type-mono inline-flex items-center gap-1 rounded-[2px] border px-2 py-[3px] ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Checkbox mark — the brand signature, and genuinely functional here          */
/* -------------------------------------------------------------------------- */

export function CheckMark({
  checked = false,
  /** Some but not all of the set is checked — draws a dash instead of a tick. */
  indeterminate = false,
  size = 22,
  className = "",
}: {
  checked?: boolean;
  indeterminate?: boolean;
  size?: number;
  className?: string;
}) {
  const filled = checked || indeterminate;

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={[
        "inline-flex shrink-0 items-center justify-center rounded-[2px] border transition-colors duration-200",
        filled
          ? "border-cross-blue bg-cross-blue text-white"
          : "border-line bg-surface text-transparent group-hover:border-cross-blue",
        className,
      ].join(" ")}
    >
      <svg
        viewBox="0 0 14 14"
        width={size * 0.6}
        height={size * 0.6}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {indeterminate && !checked ? <path d="M2.5 7h9" /> : <path d="M2 7.5 5.5 11 12 3.5" />}
      </svg>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

const fieldBase =
  "w-full rounded-[2px] border border-line bg-surface px-3 py-2 text-[16px] " +
  "text-ink placeholder:text-muted/70 focus:border-cross-blue focus:outline-none " +
  "focus-visible:outline-2 focus-visible:outline-cross-blue";

export function Input({ className = "", ...rest }: ComponentPropsWithoutRef<"input">) {
  return <input className={`${fieldBase} min-h-11 ${className}`} {...rest} />;
}

export function TextArea({ className = "", ...rest }: ComponentPropsWithoutRef<"textarea">) {
  return <textarea className={`${fieldBase} ${className}`} {...rest} />;
}

export function Select({
  className = "",
  children,
  ...rest
}: ComponentPropsWithoutRef<"select">) {
  return (
    <select className={`${fieldBase} min-h-11 ${className}`} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="type-eyebrow text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[15px] text-muted">{hint}</span> : null}
    </label>
  );
}

/* -------------------------------------------------------------------------- */
/* Status line                                                                */
/* -------------------------------------------------------------------------- */

/** A plain status line. Never a fake percentage bar. */
export function StatusLine({
  children,
  tone = "default",
}: {
  children: ReactNode;
  tone?: "default" | "warn";
}) {
  return (
    <p
      role="status"
      className={`type-mono ${tone === "warn" ? "text-warn" : "text-muted"}`}
    >
      {children}
    </p>
  );
}
