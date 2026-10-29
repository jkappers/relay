---
name: Relay
description: An operator console drawn as a telephone exchange. Lines, patches, and calls you can trace end to end, at log-explorer density.
colors:
  ground: "#fcfcfd"
  rail: "#f5f6f8"
  raised: "#ffffff"
  hover: "#f1f2f5"
  sel: "#eef2fd"
  ink: "#16181d"
  ink-2: "#4a505b"
  ink-3: "#646a76"
  rule: "#e8e9ed"
  line: "#d7dae0"
  edge: "#858b96"
  accent: "#1d4ed8"
  accent-hover: "#1a40b0"
  accent-ink: "#ffffff"
  accent-wash: "#e3e9fb"
  ok: "#1b8040"
  warn: "#b26a00"
  bad: "#d0313a"
  ok-ink: "#16703a"
  warn-ink: "#8f5200"
  bad-ink: "#b8222b"
  bad-ink-on: "#ffffff"
  skeleton: "#eceef1"
  ground-dark: "#0e0f12"
  rail-dark: "#0a0b0d"
  raised-dark: "#16181c"
  hover-dark: "#1c1e23"
  sel-dark: "#161d2e"
  ink-dark: "#e6e8ec"
  ink-2-dark: "#a9aeb8"
  ink-3-dark: "#8a909b"
  rule-dark: "#22252a"
  line-dark: "#30333a"
  edge-dark: "#646a75"
  accent-dark: "#7aa2ff"
  accent-hover-dark: "#9ab8ff"
  accent-ink-dark: "#0a0b0d"
  accent-wash-dark: "#1a2747"
  ok-dark: "#45c06c"
  warn-dark: "#eda23a"
  bad-dark: "#ff6b66"
  ok-ink-dark: "#6fd38f"
  warn-ink-dark: "#f3b55c"
  bad-ink-dark: "#ff8a85"
  bad-ink-on-dark: "#0a0b0d"
  skeleton-dark: "#1f2227"
typography:
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    fontFeature: "\"tnum\", \"cv05\""
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
    fontFeature: "\"tnum\", \"cv05\""
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1rem"
  jack-code:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "0.625rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.04em"
rounded:
  jack: "2px"
  ctl: "4px"
spacing:
  unit: "4px"
  ctl: "28px"
  cell: "32px"
  rail: "200px"
  panel: "512px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.ctl}"
    padding: "0 10px"
    height: "{spacing.ctl}"
  button-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.ctl}"
    padding: "0 10px"
    height: "{spacing.ctl}"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-ink}"
  button-danger:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.bad-ink}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl}"
  button-danger-solid:
    backgroundColor: "{colors.bad}"
    textColor: "{colors.bad-ink-on}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl}"
  button-quiet:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.ctl}"
    height: "{spacing.ctl}"
  button-sm:
    typography: "{typography.label}"
    padding: "0 8px"
    height: "24px"
  button-icon:
    rounded: "{rounded.ctl}"
    size: "{spacing.ctl}"
  input:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.ctl}"
    padding: "0 8px"
    height: "{spacing.ctl}"
  segmented-option-checked:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.jack}"
  nav-item:
    textColor: "{colors.ink-2}"
    typography: "{typography.body}"
    rounded: "{rounded.ctl}"
    padding: "0 8px"
    height: "{spacing.ctl}"
  nav-item-active:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  table-row:
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    padding: "0 12px"
    height: "{spacing.cell}"
  table-row-hover:
    backgroundColor: "{colors.hover}"
  table-row-selected:
    backgroundColor: "{colors.sel}"
  jack:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.jack}"
    height: "24px"
  jack-code:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-2}"
    typography: "{typography.jack-code}"
    rounded: "{rounded.jack}"
    height: "20px"
  detail-panel:
    backgroundColor: "{colors.raised}"
    width: "{spacing.panel}"
    padding: "12px 16px"
---

# Design System: Relay

## Overview

**Creative North Star: "The Exchange"**

The console still works like a telephone switchboard. Connections are lines. Routes are patch cords from a line jack to destination jacks. Each event is a call, and five small lamps show how far it got. What changed is the frame. It is now plain, neutral equipment: near-white in light mode and near-black in dark mode, with greys that lean only slightly cool. Exchange blue is still the only color that isn't a lamp. It means "live, primary, or yours to press."

The density is a log explorer. Lists are tables of single-line 32px rows, one fact per column, more than 20 to a desktop screen. Each row says just enough to scan: a tiny trace, the type, the line, a short outcome, the age, and an icon Replay when something failed. Everything else (the full cause, every timestamp, the payload) lives in a slide-over panel that opens beside the list and has its own link. Keys move you through it: `j` and `k` to move, Enter to open, Esc to close, `/` to filter.

Motion stays small and mechanical. Lamps settle into place when their state changes. The panel slides in a short way. Buttons and rows shift color fast on hover. Nothing else moves.

**Key Characteristics:**
- Neutral near-white (light) and near-black (dark) grounds; both themes are first class.
- One accent, exchange blue, for live, primary, and focused things.
- Four lamp states that always carry words. Grey means nothing happened; amber means work is still in flight.
- Single-line 32px rows, one fact per column; detail lives in the slide-over panel.
- Inter at a 13px base, system mono at 12px, tabular numbers everywhere.
- Flat surfaces, 4px control corners, 2px jack corners, hairline rules.

## Colors

Neutral greys with a faint cool lean, one blue accent, and three lamp colors.

### Primary
- **Exchange Blue** (`accent`): links, the primary button, focus rings, live cords and sockets, the active nav icon, the selected theme icon, the Relay mark, and the border of the one-time secret box. `accent-hover` is the hover shade of the primary button and links. `accent-ink` is text on blue. `accent-wash` is used only for text selection.

### Tertiary (lamp colors)
- **Lamp Green** (`ok`), **Lamp Amber** (`warn`), **Lamp Red** (`bad`): fills and strokes for lamps, trace wires, and status hairlines only.
- **Green Ink** (`ok-ink`), **Amber Ink** (`warn-ink`), **Red Ink** (`bad-ink`): the text versions. Any word in a status color uses these.
- **Ink on Red** (`bad-ink-on`): text on a solid red confirm button.

### Neutral
- **Ground** (`ground`): the page and the sticky table header.
- **Rail** (`rail`): the left navigation rail, the mobile header, and the track behind segmented controls. A step darker than the ground in light mode, a step deeper in dark mode.
- **Raised** (`raised`): buttons, inputs, jacks, the slide-over panel, open forms, and the 24h count strip.
- **Hover Fill** (`hover`): row hover, button hover, nav hover, and the current nav item.
- **Selection Fill** (`sel`): the selected list row (the one the keyboard is on, or the one open in the panel). It is a pale tint of the accent's hue.
- **Ink** (`ink`), **Ink 2** (`ink-2`), **Ink 3** (`ink-3`): primary text; secondary text, IDs, and plain outcomes; then column headers, meta, hints, ages, and placeholders.
- **Hairline** (`rule`): dividers between rows and sections. Decorative only.
- **Line** (`line`): borders on buttons, segmented controls, jacks, `kbd` keys, and the panel's left edge; the unlit wire in a trace; the mobile patch tree.
- **Edge** (`edge`): input and select borders, button borders on hover, unlit lamp rings, and idle cords.
- **Skeleton** (`skeleton`): loading bars.

### Contrast (computed, WCAG 2.x)

| Pair | Light | Dark |
|---|---|---|
| ink on ground | 17.32 | 15.62 |
| ink-2 on ground | 7.91 | 8.61 |
| ink-3 on ground / raised / rail | 5.30 / 5.43 / 5.02 | 5.97 / 5.54 / 6.13 |
| ink-3 on hover / sel (age in a hovered or selected row) | 4.85 / 4.85 | 5.20 / 5.24 |
| ink on sel | 15.86 | 13.70 |
| bad-ink on sel / hover | 5.68 / 5.68 | 7.38 / 7.33 |
| accent on ground (links, focus ring) | 6.54 | 7.70 |
| accent-ink on accent / accent-hover | 6.70 / 8.73 | 7.91 / 10.01 |
| ok-ink / warn-ink / bad-ink on ground | 6.00 / 6.07 / 6.20 | 10.40 / 10.56 / 8.42 |
| bad-ink-on on bad | 5.02 | 7.08 |
| edge on ground / raised (input borders, unlit rings) | 3.34 / 3.43 | 3.52 / 3.27 |
| ok / warn / bad lamp fill on ground | 4.87 / 4.13 / 4.90 | 8.22 / 8.97 / 6.89 |
| line on ground (button and jack borders) | 1.37 | 1.52 |
| rule on ground (hairline) | 1.18 | 1.25 |
| hover / sel fill on ground | 1.09 / 1.09 | 1.15 / 1.14 |

The last three rows are below 3:1 on purpose. They are not allowed to be the only thing that tells you what a control is or what state it is in. Text, icons, the focus ring, and the open panel carry that.

### Named Rules

**The One Accent Rule.** Exchange blue is the only non-lamp hue. It marks what is live, primary, or focused. Never use it for decoration or status, and never add a second accent.

**The Ink Twin Rule.** Every lamp color has a fill and an ink. Fills are for shapes. Words use the ink. Light amber fill is 4.13:1, so lamp fills never carry text.

**The Grey Line Rule.** Grey (unlit) means nothing happened: not reached, no route, line inactive, disabled. Amber is only for work still in flight: pending, running, retrying, waiting to route. Red is only for failure.

## Typography

**Body Font:** Inter (variable, 400–700), self-hosted woff2, with ui-sans-serif and system-ui fallbacks. Features `tnum` and `cv05` are on everywhere.
**Label/Mono Font:** the system monospace stack (ui-monospace, SF Mono, Menlo, Consolas)

**Character:** One compact, neutral sans does the talking at small sizes. Mono marks anything a machine made.

### Hierarchy
- **Title** (600, 17px / 24px, tight tracking): the one page title (h1), with a 12px ink-3 meta line beside it on the same baseline.
- **Body** (400, 13px / 20px): the UI base. Table cells, buttons, inputs, nav, panel facts, notices.
- **Label** (500 or 600, 12px / 16px): column headers (500, ink-3), form labels (500, ink-2), section heads (600, ink-2), small buttons, hints, ages, key hints.
- **Mono** (400, 12px / 16px): event types, IDs, payload JSON, condensed failure causes (500, red ink), the type-prefix filter, the panel title.
- **Jack code** (mono, 10px, uppercase, 0.04em): short line and destination codes inside jacks (WHK, SLK, HTTP, AGT, ANY).

The working scale is 10 / 12 / 13 / 17. Weights are 400, 500, and 600; there is no bold.

### Named Rules

**The Directory Rule.** Machine text is mono, human text is sans. Event types, IDs, codes, causes, and payloads are always mono; names, labels, and explanations never are.

**The Short Code Rule.** Uppercase short codes (jack kinds, and the trace stages RCV, VER, RTE, DLV, ACT) appear only where the full name is also present as a `title`, visible text, or screen-reader text.

## Layout

- **Grid unit:** 4px. All spacing is a multiple of it.
- **Control height:** 28px for buttons, inputs, selects, segmented controls, and nav items. Small buttons are 24px; the inline copy button is 20px.
- **Row height:** 32px for every list row at 768px and up, divided by a 1px hairline. Cells pad 12px at the sides with 16px column gaps.
- **Frame:** a 200px left rail beside the main column at 768px and up. The main column pads 16px (mobile) or 24px (desktop) and caps at 90rem.
- **Mobile frame:** below 768px the rail becomes a sticky 48px header with the mark and a menu button. Filters go full width below 640px.
- **Slide-over panel:** 512px wide, pinned to the right, full height. At 1280px and up the main column makes room for it, so the list stays visible and usable beside it. From 768px to 1279px it covers the right side of the list. Below 768px it fills the screen. Its header is 44px: mono event type, age, Refresh, Close.
- **Page header:** title and meta on the left, actions on the right, 12px to content. Sections stack 16px apart.
- **Breakpoints in use:** 640px (filters wrap), 768px (rail, single-line rows, panel width), 1024px (route form goes to two columns), 1280px (panel docks beside the list). Patch cords use a 28rem container query instead of a page breakpoint.
- **375px floor:** nothing scrolls sideways at 375px. Long values truncate with the full text in a `title`; payload JSON scrolls inside its own box.

### Named Rules

**The Single Line Rule.** At 768px and up, a list row is one line, 32px tall. If a fact doesn't fit, it gets condensed or it moves to the panel; the row never grows a second line. Below 768px a row may stack to two lines (trace, type, age; then line, outcome, action), and no more.

**The One Fact Rule.** Each column holds one fact: trace, type, line, outcome, age, action. Don't merge two facts into a cell, and don't put a sentence in a column.

**The Panel Rule.** Detail lives in the slide-over panel, never in the row. The full cause, exact UTC times, deliveries, actions, and payloads are panel content. The panel has its own URL (`#/events/<id>`, or `?event=<id>` on other pages) and is non-modal: the list stays live, and `j` and `k` move the panel to the next or previous call.

**The Cell Rule.** Controls are 28px, rows are 32px, and all spacing comes from the 4px scale.

## Elevation & Depth

The frame is flat. Depth comes from tone: rail, ground, and raised are three close steps of the same neutral, divided by hairlines and lines.

### Shadow Vocabulary
- **Panel** (`box-shadow: 0 8px 24px -12px rgb(10 11 13 / 0.3)`): the slide-over panel, open forms (new or edit route, new destination), the secret box, the sign-in form, and the inline Replay confirm that covers the row end.
- **Segment lift** (`box-shadow: 0 0 0 1px var(--line), 0 1px 2px rgb(10 11 13 / 0.08)`): the checked option inside a segmented control only.

### Named Rules

**The Flat Frame Rule.** Nothing floats except the detail panel, a form you are filling in, a secret you must copy, or a confirm you must answer. Rows, jacks, and buttons have no shadow.

## Shapes

Two small radii. Controls and containers (buttons, inputs, selects, segmented tracks, nav items, the count strip, JSON boxes, forms, the secret box) use 4px (`ctl`). Small parts inside them (jacks, jack codes, `kbd` keys, segmented options, skeleton bars) use 2px (`jack`). Borders are 1px. Lamps and trace dots are the only round shapes. Patch cords are smooth cubic curves, the one soft line in a square world.

### Named Rules

**The Square Jack Rule.** Never round past 4px. Pills, round badges, and soft cards don't belong on the exchange.

## Components

### Lamps (signature)
Small SVG indicators: 6px dots in the inline trace, 8px in outcome chips and the count strip, 10px in the panel trace and status marks. Each state differs by shape as well as color, so color is never the only signal.
- **ok:** solid green with a green-ink ring.
- **warn:** hollow amber-ink ring with an amber dot (pending, running, retrying, waiting to route).
- **bad:** solid red with a horizontal bar cut through it (failed).
- **off:** thin hollow edge-colored ring (not reached, no route, line inactive, disabled).

Every lamp is hidden from screen readers and paired with words: visible text, a `title`, or an accessible label. Status words use the matching ink: red and amber ink for bad and warn, plain ink for ok, ink 3 for off.

### Inline Trace (signature)
Five 6px dots on one baseline in a 56px track (received, verified, routed, delivered, acted), joined by 1px wires. A wire takes the state of the stage it leads to, up to the first failure or the last lit dot; past that it is the `line` color. The whole trace is one image with a full spoken label ("Trace. Received: Received and stored. …"), and its tooltip lists each stage code with its text.

### Panel Trace (signature)
The panel opens with the five stages stacked: lamp, stage name, and stage text in three columns, joined by a 1px vertical wire. Failed and in-flight text use red and amber ink.

### Call Log Table
- Columns at 768px and up: trace (56px), type (mono), line (jack code plus mono ID), outcome, age (right-aligned), and a 28px action column.
- **Outcome** is condensed: "1 delivered", "2 pending", "no route", "echo skipped", "routing", or for a failure a short cause in mono red ink such as `ECONNREFUSED :4555`, `HTTP 503`, or `timeout 10s`. The full error is in the cell's `title` and in the panel.
- **Age** is short relative time ("22m", "4h") with the absolute UTC time in the `title` and for screen readers. The panel shows absolute UTC times to the millisecond (`2026-10-25 23:13:47.552 UTC`).
- **Replay** is an icon-only quiet button at the row end, only on failed rows. Pressing it opens an inline confirm ("Replay?" plus Replay and Cancel) that floats over the row end on the raised plate.
- **States:** hover is the hover fill. Selection is the selection fill only, with no border or bar. Keyboard focus on a row draws a 2px accent ring inset on the whole row.
- **Header:** a sticky 28px row on the ground color, 12px ink-3 labels, a hairline below.

### Outcome Facets
A segmented control above the call log: All, Failed, Pending, No route, Echo, Delivered. Each option shows its lamp (where it has one), its label, and its count in ink 3. The checked option gets the raised plate and the segment lift. Each option has a `title` that explains what it matches.

### Filters
Type prefix (mono input, focused by `/`), a time-range preset menu (All time, Last 15m, 1h, 24h, 7d), provider, and connection. These are 28px native selects with a drawn chevron. A quiet Clear button appears once any filter is set. Key hints (`/` filter, `j` `k` move, Enter open, Esc close) sit at the right in 12px ink 3 with `kbd` keys, and are hidden below 768px.

### Patch Cords (signature)
A source jack on the left, destination jacks on the right, and a 48px gutter where cords curve from the source to each destination.
- **Jack:** 24px tall, raised plate, 1px line border, 2px radius, a 20px jack-code chip on the left, 12px label truncated. A 6px square socket sits on the jack's outer edge.
- **Live (route enabled):** solid accent cords (1.5px), solid accent sockets.
- **Idle (route disabled):** dashed edge cords (4 3), hollow sockets, hairline jack borders, ink 2 text.
- **Destination lamps:** in the panel, a destination jack can hold a lamp, the destination name, and a short "via route" note.
- **Narrow container (under 28rem):** the cord drawing is hidden. Destinations indent under the source on a 1px line with a short stub to each jack, like a directory tree.

### Buttons
- **Shape:** 4px radius, 1px line border, 28px tall, 10px side padding, 13px medium (500) text with an optional 14px icon.
- **Default:** raised plate, ink text. Hover gives the hover fill and an edge border (100ms).
- **Primary:** solid accent with accent ink; hover goes to accent hover. One per page or form (New route, Add a connection, Copy, Confirm).
- **Danger:** default button with red-ink text. **Danger solid** (red fill) appears only as the confirm step.
- **Quiet:** no border or fill, ink 2 text. **Small:** 24px tall, 12px text. **Icon:** square, label in `aria-label` and `title`.
- **Disabled:** 55% opacity, no hover change.
- **Confirm pattern:** destructive or outward actions swap in place to a question, a confirm button (primary or danger solid, autofocused), and Cancel. Results are announced.

### Inputs / Fields
- **Style:** raised plate, 1px edge border, 4px radius, 28px tall, 13px text. Selects use a drawn chevron.
- **Focus:** accent border plus a 2px accent outline with no offset.
- **Labels:** 12px medium ink 2 above the field; hints in 12px ink 3 linked by `aria-describedby`.
- **Errors:** a notice between red hairlines in red ink, with `role="alert"`.

### Navigation
- A 200px rail on the rail tone: the Relay mark (52px header), six items, then the theme switch and Sign out at the bottom above a hairline.
- Items are 28px tall, 4px radius, 13px medium, ink 2, with a 16px ink-3 line icon. Hover gives the hover fill. The current page gets the hover fill, ink text, an accent icon, and `aria-current="page"`.
- The theme switch is a three-option segmented control (light, dark, system), icon only. The checked option gets the raised plate and an accent icon.

### Detail Panel
A non-modal `role="dialog"` on the raised plate with a 1px line border on its left edge and the panel shadow. It slides in 1rem over 150ms. It takes focus when it opens; Esc closes it and returns focus to the row. Its body scrolls on its own. Sections (Call, Deliveries, Actions, Agent runs, Envelope, Raw payload) start with a hairline and a 12px semibold ink-2 head with a count in ink 3. Facts are a two-column list: 12px ink-3 terms, 13px values.

### 24h Count Strip
A line at least 32px tall on the raised plate with a hairline border and 4px corners: calls, delivered, pending (amber ink when non-zero), failed (red ink and a bad lamp when non-zero), then agent runs and cost in ink 3 at the right. Counts are links to the matching list. It is a summary line, not a set of tiles.

### Secret Box
A one-time panel with a 1px accent border, 4px corners, and the panel shadow. It says "You won't see this again. Copy it now." in amber ink, shows the value in a read-only mono input, and offers Copy and "I saved it." Once dismissed, the value is gone from the UI.

### Notices, Empty, and Loading
- **Notices:** one line between two hairlines (red for error, green for ok), with a small Retry button when a load failed. Stale data stays on screen under a "Refresh failed" notice.
- **Empty states:** a semibold line, one sentence, and one next action, between hairlines.
- **Skeletons:** flat 10px bars in the skeleton tone, laid out like the rows they replace.

### Motion
- **Settle:** lamps scale from 55% and fade in over 180ms on `cubic-bezier(0.16, 1, 0.3, 1)`. Panel trace lamps stagger 30ms per stage. A lamp replays settle only when its state changes.
- **Slide:** the panel fades in and moves 1rem from the right over 150ms on the same curve.
- **Hover:** buttons shift background, border, and color over 100ms. The Details chevron rotates when opened.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, all animations and transitions are off.

### Focus
Every focusable element gets a 2px accent outline with a 2px offset (6.54:1 on light ground, 7.70:1 on dark). Inputs pull the outline in and color their border. Rows draw the ring inset. A skip link appears on first Tab. Route changes move focus to the main region.

## Do's and Don'ts

### Do:
- **Do** keep exchange blue as the only accent, and use it for every live, primary, or focused state.
- **Do** keep list rows to one 32px line at 768px and up, with one fact per column.
- **Do** condense causes in the row (`ECONNREFUSED :4555`, `HTTP 503`) and put the full text in a `title` and the panel.
- **Do** put detail in the slide-over panel, give it a deep link, and keep `j`, `k`, Enter, Esc, and `/` working on every list that opens it.
- **Do** show selection with the selection fill, and keep the focus ring for keyboard focus.
- **Do** use grey lamps for "nothing happened" and amber only for work in flight.
- **Do** pair every lamp with its words, and use the `-ink` colors for status text.
- **Do** set event types, IDs, codes, causes, and payloads in mono, and everything else in Inter.
- **Do** size controls to 28px and rows to 32px, and space on the 4px grid.
- **Do** draw routes as patch cords, live in accent and idle as dashed edge, and collapse them to an indented tree in narrow containers.
- **Do** confirm destructive or outward actions in place, and announce the result.
- **Do** design every screen for both themes and check contrast in each against WCAG 2.2 AA.
- **Do** keep every route free of horizontal scroll at 375px.
- **Do** stay within the gzipped budgets: JS ≤ 90 KB, CSS ≤ 25 KB, fonts ≤ 120 KB.

### Don't:
- **Don't** use inline `style` attributes or inline scripts. The CSP (`script-src 'self'; style-src 'self'`) blocks them. Put styling in the stylesheet or Tailwind classes.
- **Don't** load fonts, scripts, or styles from another origin. Fonts are self-hosted only.
- **Don't** render event text or payloads as HTML. Untrusted text renders as text; no `dangerouslySetInnerHTML` or `innerHTML`.
- **Don't** show a secret twice. Secrets appear once, in the secret box, at create or rotate.
- **Don't** let a list row grow a second line at desktop width, or put a sentence, a payload, or a full error in a row.
- **Don't** let a fill, a hairline, or a `line` border be the only sign of a control or its state.
- **Don't** use amber for "no route" or "not reached", or use lamp colors for decoration.
- **Don't** put words in a lamp fill color.
- **Don't** wrap list data in padded cards or build KPI tiles.
- **Don't** add shadows to rows, jacks, or buttons, or round corners past 4px.
- **Don't** add a second accent hue.
