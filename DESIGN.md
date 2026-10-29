---
name: Relay
description: An operator console drawn as a telephone exchange. Lines, patches, and calls you can trace end to end.
colors:
  ground: "#e6ebe7"
  rail: "#d5ddd7"
  raised: "#f4f7f5"
  ink: "#141c18"
  ink-2: "#3e4a44"
  ink-3: "#55625b"
  rule: "#c4cdc7"
  edge: "#6c7771"
  accent: "#1d4ed8"
  accent-hover: "#1a40b0"
  accent-ink: "#ffffff"
  accent-wash: "#d3ddf3"
  ok: "#1c7a3e"
  warn: "#a86200"
  bad: "#c0262d"
  ok-ink: "#17653a"
  warn-ink: "#8a5000"
  bad-ink: "#a3161d"
  bad-ink-on: "#ffffff"
  skeleton: "#d5ddd7"
  ground-dark: "#121614"
  rail-dark: "#0a0c0b"
  raised-dark: "#1a1f1c"
  ink-dark: "#e3e9e5"
  ink-2-dark: "#b0bab4"
  ink-3-dark: "#8f9b94"
  rule-dark: "#262c29"
  edge-dark: "#6b7670"
  accent-dark: "#7aa2ff"
  accent-hover-dark: "#9ab8ff"
  accent-ink-dark: "#0a0c0b"
  accent-wash-dark: "#1b2847"
  ok-dark: "#4cc272"
  warn-dark: "#f0a63a"
  bad-dark: "#ff6b66"
  ok-ink-dark: "#6fd38f"
  warn-ink-dark: "#f3b55c"
  bad-ink-dark: "#ff8a85"
  bad-ink-on-dark: "#0a0c0b"
  skeleton-dark: "#222825"
typography:
  headline:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: "1.75rem"
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 700
    lineHeight: "1.375rem"
  body:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.375rem"
    fontFeature: "tnum"
  body-sm:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    fontFeature: "tnum"
  label:
    fontFamily: "Atkinson Hyperlegible Next, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
    lineHeight: "1rem"
    letterSpacing: "0.02em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  jack-code:
    fontFamily: "ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0.025em"
rounded:
  jack: "2px"
spacing:
  unit: "4px"
  cell: "32px"
  rail: "216px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.jack}"
    padding: "0 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.ink}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.jack}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-ink}"
  button-danger:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.bad-ink}"
    rounded: "{rounded.jack}"
    height: "32px"
  button-danger-solid:
    backgroundColor: "{colors.bad}"
    textColor: "{colors.bad-ink-on}"
    rounded: "{rounded.jack}"
    height: "32px"
  button-quiet:
    textColor: "{colors.ink-2}"
    height: "32px"
  button-sm:
    typography: "{typography.label}"
    padding: "0 8px"
    height: "28px"
  input:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.jack}"
    padding: "4px 8px"
    height: "32px"
  nav-item:
    textColor: "{colors.ink-2}"
    typography: "{typography.body-sm}"
    padding: "0 10px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.accent-wash}"
    textColor: "{colors.ink}"
  jack:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm}"
    height: "{spacing.cell}"
  jack-code:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink-2}"
    typography: "{typography.jack-code}"
    height: "24px"
  panel:
    backgroundColor: "{colors.raised}"
    padding: "16px"
---

# Design System: Relay

## Overview

**Creative North Star: "The Exchange"**

The console looks and works like a telephone switchboard. Connections are lines. Routes are patch cords from a line jack to destination jacks. Each event is a call, and a row of five lamps shows how far it got. The frame is plain enamel equipment in light mode and black bakelite in dark mode. The only color that isn't a lamp is exchange blue, and it means "live, selected, or yours to press."

The density is a phone directory, not a dashboard. Rows are compact and divided by hairline rules. Machine text (event types, IDs, payloads, short codes) is set in mono. There are no KPI tiles and no padded cards around list data. Truth comes before comfort: failures show their cause inline, in red ink, with a Replay control at the end of the row.

Motion is small and mechanical. A lamp settles into place when its state changes, like a bulb warming up. Nothing else animates except quick color shifts on hover.

**Key Characteristics:**
- Cool grey-green enamel frame (light) or black bakelite (dark); both themes are first class.
- One accent, exchange blue, for every live, selected, focused, or primary thing.
- Four lamp states (lit green, amber, red, unlit) that always carry text.
- Patch cords drawn from a source jack to each destination jack.
- Directory-dense rows on a 4px grid with a 32px cell.
- Flat surfaces, square-ish 2px corners, hairline rules.

## Colors

A low-chroma grey-green frame with one blue accent and three lamp colors.

### Primary
- **Exchange Blue** (`accent`): links, the primary button, focus rings, live jacks and cords, the selected theme option, the active nav icon, the Relay mark, and the border of the one-time secret box. `accent-hover` is the pressed or hovered shade. `accent-ink` is text on blue. `accent-wash` is the pale blue behind the active nav item, button hover, and text selection.

### Tertiary (lamp colors)
- **Lamp Green** (`ok`), **Lamp Amber** (`warn`), **Lamp Red** (`bad`): fills and strokes for lamps, trace wires, and status borders only.
- **Green Ink** (`ok-ink`), **Amber Ink** (`warn-ink`), **Red Ink** (`bad-ink`): the text versions. Use these for any words in a status color.
- **Red Ink On** (`bad-ink-on`): text on a solid red button.

### Neutral
- **Enamel** (`ground`): the page background.
- **Frame Rail** (`rail`): the left navigation rail and mobile header. Darker than the ground in light mode, near black in dark mode.
- **Raised Plate** (`raised`): buttons, inputs, jacks, payload boxes, form panels, and row hover.
- **Ink** (`ink`), **Ink 2** (`ink-2`), **Ink 3** (`ink-3`): primary text, secondary text and metadata, and hints, placeholders, and empty values.
- **Hairline** (`rule`): dividers between rows and sections. Decorative only, never the sole boundary of a control.
- **Edge** (`edge`): borders on controls (buttons, inputs, jacks) and unlit cords and wires.
- **Skeleton** (`skeleton`): loading bars.

### Contrast (computed, WCAG 2.x)

| Pair | Light | Dark |
|---|---|---|
| ink on ground | 14.39 | 14.82 |
| ink-2 on ground | 7.67 | 9.15 |
| ink-3 on ground | 5.30 | 6.33 |
| ink-3 on raised | 5.93 | 5.80 |
| ink on accent-wash | 12.74 | 11.83 |
| accent on ground (links, focus) | 5.55 | 7.34 |
| accent-ink on accent | 6.70 | 7.89 |
| ok-ink / warn-ink / bad-ink on ground | 5.88 / 5.39 / 6.47 | 9.90 / 10.06 / 8.02 |
| bad-ink-on on bad | 5.90 | 7.05 |
| edge on ground (control borders) | 3.85 | 3.87 |
| edge on raised | 4.31 | 3.54 |
| ok / warn / bad lamp fill on ground | 4.46 / 3.94 / 4.89 | 8.05 / 8.88 / 6.56 |
| rule on ground (hairline) | 1.35 | 1.28 |

### Named Rules

**The One Accent Rule.** Exchange blue is the only non-lamp hue. It marks what is live, selected, focused, or the next action. Never use it for decoration or status, and never add a second accent.

**The Ink Twin Rule.** Every lamp color has a fill and an ink. Fills are for shapes. Words use the ink. In light mode the green and amber fills fall below 4.5:1, so they must never carry text.

## Typography

**Body Font:** Atkinson Hyperlegible Next (variable, 200–800), self-hosted, with ui-sans-serif and system-ui fallbacks
**Label/Mono Font:** the system monospace stack (ui-monospace, SF Mono, Menlo, Consolas)

**Character:** One highly legible sans at small sizes does all the talking. Mono marks anything a machine made.

### Hierarchy
- **Headline** (700, 20px / 28px, tight tracking): the one page title (h1) in each page header.
- **Title** (700, 14px / 22px): section heads (h2) above a hairline.
- **Body** (400, 14px / 22px): default text. Numbers are tabular everywhere.
- **Body small** (400, 13px / 20px): table cells, buttons, inputs, nav, metadata, outcome text.
- **Label** (700, 12px / 16px, +0.02em): form labels, the call-log column header, small buttons, hints (at 400).
- **Mono** (400, about 13px): event types, IDs, payload JSON, route filters.
- **Jack code** (mono, 11px, uppercase, slight tracking): three- or four-letter codes inside jacks (SLK, WHK, HTTP, AGT, ANY).

The scale is 12 / 13 / 14 / 20 (plus a 24px step that no screen uses yet). Weights are 400 and 700; buttons use 600. Overview counts use the headline size as numerals next to small labels.

### Named Rules

**The Directory Rule.** Machine text is mono, human text is sans. Event types, IDs, codes, and payloads are always mono; names, labels, and explanations never are.

**The Short Code Rule.** Uppercase three-letter codes (jack kinds, and the trace stages RCV, VER, RTE, DLV, ACT) are allowed only when the full name is also present as a title, an `abbr`, or screen-reader text.

## Layout

- **Grid unit:** 4px. All spacing is a multiple of it.
- **Cell:** 32px. Buttons, inputs, jacks, and the theme switch are one cell tall. Small buttons are 28px; nav items are 36px.
- **Frame:** a 216px left rail (`rail`) beside the main column at 768px and up. The main column is padded 16px (mobile) or 32px (desktop) and capped at 78rem.
- **Mobile frame:** below 768px the rail becomes a sticky 56px header with the mark and a menu button. The nav opens below it.
- **Breakpoints in use:** 640px (patch cords, trace detail), 768px (rail), 1024px (call-log columns).
- **Rows, not cards:** lists are rows between hairline rules, with 8px side padding and 10px vertical padding. Row hover is the raised plate.
- **Call log:** at 1024px and up, five columns: call, line, age, trace (120px), outcome. Below that, each row stacks into call and age, then trace and line, then outcome across the full width.
- **Page header:** title and one-line meta on the left, actions on the right, a hairline below, 20px to content. Sections stack 24px apart.
- **375px floor:** nothing scrolls sideways at 375px. Long values truncate or wrap; wide content (payload JSON) scrolls inside its own box.

### Named Rules

**The Cell Rule.** If it is a control or a jack, it is one cell (32px) tall. Spacing comes only from the 4px scale.

## Elevation & Depth

The frame is flat. Depth comes from tone: rail, ground, and raised plate are three steps of the same grey-green, divided by hairlines and edges.

### Shadow Vocabulary
- **Panel** (`box-shadow: 0 6px 16px -8px rgb(10 12 11 / 0.35)`): only on open forms (new or edit route, new destination) and the one-time secret box.

### Named Rules

**The Flat Frame Rule.** Nothing on the frame floats except a form you are filling in or a secret you must copy. Lists, rows, jacks, and buttons have no shadow.

## Shapes

Corners are square-ish: a 2px radius (`jack`) on buttons, inputs, and skeleton bars; jacks and panels are square. Borders are 1px. The secret box uses a 2px accent border. Lamps are the only round status shapes. Patch cords are smooth cubic curves, the one soft line in a square world.

### Named Rules

**The Square Jack Rule.** Never round past 2px. Pills, round badges, and soft cards don't belong on the exchange.

## Components

### Lamps (signature)
Small 12px SVG indicators (16px in the trace detail). Each state differs by shape as well as color, so color is never the only signal.
- **ok:** solid green with a green-ink ring.
- **warn:** hollow amber-ink ring with an amber dot (pending, running, retrying, waiting, not matched).
- **bad:** solid red with a horizontal bar cut through it (failed).
- **off:** thin hollow edge-colored ring (not reached, inactive, disabled).

Every lamp is hidden from screen readers and paired with words: a `title` tooltip, visible text, or an `aria-label`. Status words use the matching ink: red and amber ink for bad and warn, plain ink for ok, ink 2 for off. Fixed text equivalents include:
- Received: "Received and stored". Verified: "Signature verified".
- Routed: "Routed to destinations", "Waiting to be routed", "Skipped: echo of a Relay message", "Not routed: no route matched", "Not routed: connection not active".
- Delivered and Acted: counts such as "3 deliveries: 2 pending or retrying, 1 succeeded", or "Not reached".

### Five-Lamp Trace (signature)
Five lamps on one baseline (received, verified, routed, delivered, acted), 24px apart in a 120px track. Wires between lamps take the state of the stage they lead to, up to the first failure or the last lit lamp. Past that, wires are 1px dashed edge. The whole trace is one image with a full spoken label ("Trace. Received: Received and stored. …"). The call-log header shows the stage codes above the lamps. On the event page, the trace detail lists each stage with its name, code, and text; it runs across in five columns at 640px and up and stacks with a vertical wire below that.

### Patch Cords (signature)
A source jack on the left, destination jacks on the right, and an 80-unit gutter between them where cords curve from the source to each destination.
- **Jack:** one cell tall, raised plate, 1px edge border, a jack-code chip on the left, label truncated. A small square socket sits on the jack's outer edge.
- **Live (route enabled):** solid accent cords (1.5px), solid accent sockets.
- **Idle (route disabled):** dashed edge cords (4 3), hollow sockets, hairline jack borders, ink 2 text.
- **Destination lamps:** on the event page a destination jack can hold a lamp and its text.
- **Mobile collapse (below 640px):** the cord drawing and the source socket are hidden. Destinations indent under the source on a 1px edge line with a short stub to each jack, like a directory tree. Order and meaning stay the same.

### Buttons
- **Shape:** 2px radius, 1px edge border, one cell tall, 12px side padding, 13px semibold text with an optional 14px icon.
- **Default:** raised plate, ink text. Hover turns it accent wash with an accent border (120ms).
- **Primary:** solid accent with accent ink; hover goes to accent hover. Used for the main action of a page or form (New route, Add a connection, Copy, Confirm).
- **Danger:** default button with red-ink text; hover adds a red border. **Danger solid** (red fill) appears only as the confirm step.
- **Quiet:** no border or fill, underlined ink 2 text. **Small:** 28px tall, 12px text. **Icon:** square.
- **Disabled:** 55% opacity, no hover change.
- **Confirm pattern:** destructive or outward actions swap in place to a question, a confirm button (primary or danger solid, autofocused), and Cancel. Results are announced.

### Inputs / Fields
- **Style:** raised plate, 1px edge border, 2px radius, one cell minimum, 13px text. Selects use a drawn chevron.
- **Focus:** accent border plus a 2px accent outline with no offset.
- **Labels:** the label style above the field; hints in 12px ink 3 linked by `aria-describedby`.
- **Errors:** a notice between red hairlines in red ink, with `role="alert"`.

### Navigation
- Left rail on the frame rail tone with the Relay mark at the top, six items, then theme switch and Sign out at the bottom.
- Items are 36px tall, 13px bold, ink 2, with a 16px line icon. Hover gives the raised plate. The current page gets accent wash, ink text, an accent icon, and `aria-current="page"`.
- The theme switch is three icon-only radios (light, dark, system). The selected one is solid accent.

### Secret Box
A one-time panel with a 2px accent border and the panel shadow. It says "You won't see this again. Copy it now." in amber ink, shows the value in a read-only mono input, and offers Copy and "I saved it." Once dismissed, the value is gone from the UI.

### Notices, Empty, and Loading
- **Notices:** text between two hairlines (red for error, green for ok), with a Retry button when a load failed. Stale data stays on screen under a "Refresh failed" notice.
- **Empty states:** a bold title, one sentence, and one next action, between hairlines.
- **Skeletons:** flat bars in the skeleton tone shaped like the rows they replace.

### Motion
- **Settle:** lamps scale from 55% and fade in over 180ms on `cubic-bezier(0.16, 1, 0.3, 1)`. Trace lamps stagger 30ms per stage. A lamp replays settle only when its state changes.
- **Hover:** buttons shift background and border over 120ms. The Details chevron rotates when opened.
- **Reduced motion:** with `prefers-reduced-motion: reduce`, all animations and transitions are turned off.

### Focus
Every focusable element gets a 2px accent outline with a 2px offset (5.55:1 on light ground, 7.34:1 on dark). Inputs pull the outline in and color their border. A skip link appears on first Tab. Route changes move focus to the main region.

## Do's and Don'ts

### Do:
- **Do** keep exchange blue as the only accent, and use it for every live, selected, focused, or primary state.
- **Do** pair every lamp with its text in a tooltip, visible text, or an accessible label, and use the `-ink` colors for status words.
- **Do** set event types, IDs, codes, and payloads in mono, and everything else in Atkinson Hyperlegible Next.
- **Do** size controls and jacks to the 32px cell and space on the 4px grid.
- **Do** show list data as rows between hairline rules, with the failure cause inline and the fix (Replay) at the row end.
- **Do** draw routes as patch cords, live in accent and idle as dashed edge, and collapse them to an indented tree below 640px.
- **Do** confirm destructive or outward actions in place, and announce the result.
- **Do** design every screen for both themes and check contrast in each against WCAG 2.2 AA.
- **Do** keep every route free of horizontal scroll at 375px.
- **Do** stay within the gzipped budgets: JS ≤ 90 KB, CSS ≤ 25 KB, fonts ≤ 120 KB.

### Don't:
- **Don't** use inline `style` attributes or inline scripts. The CSP (`script-src 'self'; style-src 'self'`) blocks them. Put styling in the stylesheet or Tailwind classes.
- **Don't** load fonts, scripts, or styles from another origin. Fonts are self-hosted only.
- **Don't** render event text or payloads as HTML. Untrusted text renders as text; no `dangerouslySetInnerHTML` or `innerHTML`.
- **Don't** show a secret twice. Secrets appear once, in the secret box, at create or rotate.
- **Don't** use lamp colors for decoration or put words in a lamp fill color.
- **Don't** wrap list data in padded cards or build KPI tiles.
- **Don't** add shadows to rows, jacks, or buttons, or round corners past 2px.
- **Don't** add a second accent hue.
