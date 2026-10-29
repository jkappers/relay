# ADR 0006: Console styles move to Tailwind CSS v4

Status: accepted (design pass)

## Decision

Replace the console's hand-written `styles.css` with Tailwind CSS v4, built by its Vite plugin.

New dependencies, in `apps/console` only, as dev dependencies with exact pins:

| Package | Why |
|---|---|
| `tailwindcss` 4.3.3 | Utility classes and the `@theme` token layer. |
| `@tailwindcss/vite` 4.3.3 | Builds the CSS inside the existing Vite build. |

Nothing else is added: no UI kit, icon library, `clsx`, or `tailwind-merge`. Class joining is a one-line helper. Icons are a small inline SVG set in `apps/console/src/icons.tsx`.

## Why

- The redesign needs one token set (color roles, type scale, cell grid, radii, motion) used the same way on every page. `@theme` defines the tokens once and generates the utilities from them, so pages cannot drift to one-off values.
- Light and dark themes are CSS variables on `:root`. Dark follows `prefers-color-scheme` unless the owner picks Light or Dark in the rail, which sets `data-theme` on `<html>`.
- The output is one static CSS file. Unused utilities are not emitted. The built CSS is about 7 KB gzipped.

## Alternatives

- **Keep plain CSS.** No new dependency, but 450 lines of ad-hoc classes had already drifted. A token-driven rebuild in plain CSS means writing a utility layer by hand.
- **CSS Modules.** Built into Vite, so no dependency. It scopes class names but gives no shared token scale.
- **CSS-in-JS (styled-components, Emotion).** Rejected: most inject `<style>` tags at runtime, which `style-src 'self'` blocks unless the CSP is loosened.

## CSP fit

The CSP stays `default-src 'self'; script-src 'self'; style-src 'self'`, with `frame-ancestors 'none'`.

- Tailwind runs at build time and emits a static stylesheet served from `'self'`. No runtime style injection.
- `style={...}` attributes are banned. `scripts/check.sh` greps for them next to the `innerHTML` ban. Dynamic geometry, such as the patch cords on the Routes page, uses SVG attributes (`d`, `viewBox`), not inline styles.
- The theme choice is applied by the bundled script, not an inline script. With a saved Light or Dark choice that differs from the system setting, the page background can show the system theme for the moment between first paint and the bundle running. The app root is empty during that moment, so no content flashes.
- The font (Atkinson Hyperlegible Next, SIL OFL 1.1) is self-hosted under `apps/console/public/fonts/` with its license. `default-src 'self'` already covers it.
