# Cross Services Group — brand spec (as applied to The Furies Scheduler)

The build spec references a companion `BRAND.md` that was not in this folder. This
file reconstructs it from the **shipped** Cross Services Group website
(`../CrossServicesSite`), which is the realised brand system — tokens sampled from
`app/globals.css`, type scale and rules from its build prompt, primitives from
`components/ui/`. Where the original prompt and the shipped site disagree (radius,
most notably), the shipped site wins, because that is what the brand actually looks
like today.

## Colour tokens

```
--cross-blue        #1255a2   exact hex from the logo mark; the action colour
--cross-blue-hover  #0f4785
--cross-navy        #0b3665   large headlines, footer, dark surfaces
--paper             #f7f6f2   page background, warm neutral — never pure white
--surface           #ffffff   cards
--ink               #1b1d21   body text
--muted             #5c6270   secondary text
--line              #e4e2db   hairline borders
```

Rules:

- Blue is the action colour. Buttons, links, active states, the checkbox fill. Nothing else.
- Navy is for large headlines and dark bands.
- Page background is `--paper`. Cards are white so they lift off it.
- **No third accent colour. No gradients.** Warning and error states are the one
  documented exception in this app (see below) and must always pair colour with
  text and an icon, never colour alone.

### App-specific addition: warning state

The schedule board has to show window violations. Colour alone fails WCAG 1.4.1,
and the brand has no red. The resolution: violations render as `--ink` text on a
hairline-bordered tag with a `!` icon and the literal word "late"/"early", plus a
single reserved warn colour used only for that border and icon.

```
--warn              #8a4b1f   window violations only. Never decorative.
```

## Typography

Loaded through `next/font/google`.

- **Display:** Newsreader. `h1`/`h2` only. Sentence case, tight leading, optical sizing on.
- **Body and UI:** IBM Plex Sans.
- **Eyebrows, labels, tags, all mono data (times, codes, addresses):** IBM Plex Mono,
  uppercase for eyebrows only, 12px, letter-spacing 0.08em. This is the only place
  all-caps and letter-spacing are allowed.

Scale (mobile, desktop in parentheses):

| Role            | Size        | Weight | Leading |
| --------------- | ----------- | ------ | ------- |
| h1              | 34px (48px) | 500    | 1.05    |
| h2              | 26px (34px) | 500    | 1.15    |
| h3 / card title | 19px (22px) | 500    | 1.25    |
| Body            | 17px        | 400    | 1.65    |
| Small           | 15px        | 400    | 1.5     |
| Eyebrow / tag   | 12px        | 500    | 1       |

Body text never below 16px — iOS zooms form inputs under 16px.
**No wide letter-spaced all-caps headings.**

## Spacing, radius, motion

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 64, 96, 128. Nothing off scale.
- Content max width 1200px; gutters 20px mobile, 32px up. The board is the one
  screen allowed to exceed 1200px, because it is a horizontally scrolling column set.
- **Radius: 3px on cards, 2px on controls and tags.** Deliberately near-square —
  nothing in this system is pill-shaped. (The original prompt said 12/8/999px; the
  shipped site is 3/2/2 and that is the brand.)
- Borders: 1px `--line`. No drop shadows at rest.
- Motion, complete list: fade+rise 12px on scroll-in (400ms), card hover lift 2px
  (200ms), the checklist strike-through. Everything wrapped in
  `prefers-reduced-motion`.

## The signature element

The tagline is "Cross it off your list." The visual language is built around **the
checklist**: a square checkbox mark that fills with Cross blue and gains a check.

In this app the checkbox is genuinely functional rather than decorative — it marks
confirmed rows on the review screen and confirm actions elsewhere. Per the build
spec: **no decorative strike-through animation on working screens.** The strike is
saved for empty states.

## Mobile

Build 375px first, add breakpoints upward. Breakpoints: base 375, `sm` 640,
`md` 768, `lg` 1024, `xl` 1280. Tap targets minimum 44×44px with 8px between
adjacent targets. One column by default.

## Header lockup

The logo is a white-background `.webp` that cannot sit on coloured surfaces, so it
is not used. Type-only lockup: "Cross Services Group" in the display face with
"The Furies Scheduler" as a mono eyebrow beneath it.

## Components

No component library. Hand-built primitives only: `Button` (primary / secondary /
tertiary / danger-quiet), `Input`, `Select`, `Card`, `Tag`, `CheckMark`, `Field`.
