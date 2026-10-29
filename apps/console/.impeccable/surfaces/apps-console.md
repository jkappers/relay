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

OWN-WORLD: Enamel equipment-frame ground (cool grey-green light; black bakelite dark), exchange blue as the only accent and the only live/selected color, indicator lamps in amber (pending/retrying), red (failed), green (succeeded), unlit grey (not reached). Directory-dense type: Atkinson Hyperlegible Next for UI, system mono for ids and payloads. One cell grid in tokens; compact rows, hairline rules, square-ish jacks, no padded cards around list data. Raises: fixed-baseline stage comparison (Botanical Folio), density courage with short codes (Circle Catalog), strict cell grid tokens (Grid Specimen), one accent owns every live state (Metro Tiles).

STORY: The visitor sees whether calls are getting through, finds the one that failed and why, and replays it; in setup they patch a line to destinations and watch the preview prove the patch.

FIRST VIEWPORT: Left rail (Relay mark, nav, sign out) on enamel; main area: overview header with 24h line counts, then the live call log: one row per event with type, source line, age, and a five-lamp trace (received, verified, routed, delivered, acted) on a shared baseline; failed rows carry the cause inline and a Replay control at the row end.

FORM: The Exchange, my candidate 7 of 7, seed key ad9e2194. Signature move: routes drawn as patch cords from a connection jack to each destination jack (routes page and event detail), and the five-lamp trace lighting stage by stage from real status.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
