---
version: 1
slug: "apps-console"
primary_target: "apps/console"
related_targets: []
---

# Relay console

Scope: the whole console SPA (login, overview, connections, destinations, routes, events, deliveries). Visitor mode: Operate.

Audience and job: technical owners (today one, later product users) who open it when something broke, for routine check-ins, and for setup. Success: cause and replay of any failure within two clicks; setup without reading docs; every guarantee visible as a checkable fact.

Constraints: strict CSP ('self' only, no inline styles), untrusted text rendered as text, secrets shown once, self-hosted fonts, Tailwind v4, no UI kit/router/icon library, WCAG 2.2 AA both themes, works at 375px.

## Direction contract

THESIS: Relay is a switchboard. Connections are lines, routes are patches, events are calls you can trace end to end. It refuses the category default of a grey dashboard with KPI tiles and one accent.

OWN-WORLD: Neutral, near-white light and near-black dark grounds with barely-tinted cool greys (owner revision 2026-10-25: the green enamel read as dated). Exchange blue is the only accent and the only live/selected color. Indicator lamps: amber (pending/retrying), red (failed), green (succeeded), unlit grey (not reached), drawn small, about 6px. Engineer-grade density at the Linear and Axiom/Datadog log-explorer bar: Inter (variable, self-hosted) at a 13px UI base with tabular numbers, system mono at 12px for ids, types, and payloads. List views are single-line 32px rows, one fact per column, causes condensed, detail in a slide-over panel, never in the row. One 4px grid in tokens; hairline rules, square-ish jacks, no padded cards around list data. Raises: fixed-baseline stage comparison (Botanical Folio), density courage with short codes (Circle Catalog), strict cell grid tokens (Grid Specimen), one accent owns every live state (Metro Tiles).

STORY: The visitor sees whether calls are getting through, finds the one that failed and why, and replays it; in setup they patch a line to destinations and watch the preview prove the patch.

FIRST VIEWPORT: A slim left rail (Relay mark, nav, sign out). The main area holds a one-line 24h count row, then the live call log as a dense table. Each row is single-line: a compact inline five-lamp trace (received, verified, routed, delivered, acted) on a shared baseline, then type, source line, the condensed outcome (failed: short cause such as "ECONNREFUSED :4555"), age, and an icon Replay control at the row end. The full cause, message, and payload live in the slide-over detail panel. More than 20 rows fit in the first desktop viewport.

FORM: The Exchange, my candidate 7 of 7, seed key ad9e2194. Signature move: routes drawn as patch cords from a connection jack to each destination jack (routes page and event detail), and the five-lamp trace lighting stage by stage from real status.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
