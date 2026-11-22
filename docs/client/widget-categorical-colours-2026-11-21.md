# Categorical widget colours and default canvases

The on-demand widget guidance used to steer authors towards one accent plus
greys ("reserve saturated colour", "emphasize one leading finding", "mute the
rest", no KPI grids or gradients), and Monochrome supplies grayscale for
`--chart-series-2..4`. Engines that followed it produced near-grey widgets;
engines that ignored it hardcoded their own light-canvas colours, which became
unreadable in dark themes and especially in CLI, the dark-only palette.

## Behaviour

`client/src/chart-palette.css` adds eight categorical hues for every palette,
each with a light and a dark set and three roles:

| Token | Use | Contrast kept |
|---|---|---|
| `--cat-N` | bars, lines, dots, swatches, borders | ≥ 3:1 on `--surface`, `--card` and its own `--cat-N-soft` |
| `--cat-N-ink` | coloured text: KPI values, category names, badge text | ≥ 4.5:1 on the same three |
| `--cat-N-soft` | tinted card, badge and row backgrounds | `--text` and `--muted` ≥ 4.5:1 |

Three value sets are used: a standard set (white palettes, Sage, Ocean), a
lower-chroma set for Monochrome and a brighter terminal set for CLI's dark
mode. CLI's light set only serves light-canvas widgets. Each palette leads
with its own hue while the first two slots stay one cool and one warm. Soft
tints are mixed into the palette's reading surface. App chrome, chat and
semantic status colours do not use these tokens. `--chart-series-1..4` are
unchanged except in Monochrome (below).

`widgetTheme` passes the current roles plus the palette's `-light`/`-dark`
sets and neutral light/dark canvas tokens (Monochrome's own values).

Monochrome's `--chart-series-1..4` (used by App reports and older widgets) now
point at its first four categorical hues in both modes; a Monochrome accent
sets only the data emphasis (report headline metric, timeline nodes, data
widget accent and primary action). Other palettes' series are unchanged.

### Default canvas

The viewer decides the canvas once from the widget source:

1. Source that mentions an App colour variable (`--text` … `--cat-N-soft`,
   `--chart-series-N`), `light-dark()`, `prefers-color-scheme` or the
   `tarobot:theme` event follows the App.
2. Otherwise, source that paints its own colours (hex, `rgb()`/`hsl()`/
   `oklch()` and similar, a named colour on a colour property, any `<svg>`,
   whose default paint is black, or an external stylesheet or script) gets a
   light canvas, or a dark one when its outermost element (or, when that is
   transparent, the body) has an opaque dark background.
3. Source with no colour of its own inherits the App's text colour and follows
   the App.

Known limits: a design drawn for dark with a transparent background and light
text gets a light canvas; `prefers-color-scheme` rules inside an external
stylesheet follow the device, not the App, because the opaque frame cannot
read or rewrite a cross-origin sheet; a
design that mixes App variables with fixed dark text follows the App and can
be hard to read in dark themes.

### Guidance

The on-demand widget guidance (`src/gateway/widget-guidance.ts`) now states
only facts a model needs for a working widget: publication, runtime limits
of the sanitized Worker DOM, frame size, optional state/composer APIs, the
theme variables and default canvas, and the report and chart-tab contracts.
Usage, layout, colour, interaction and data-presentation advice was removed.

## Compatibility

- No protocol, persisted data, sandbox permission or frozen native tool
  definition changes. The headless CLI shares the guidance; no new command.
- Older clients do not define `--cat-*`; widgets that rely on them lose those
  fills there. Historical widgets keep their own colours; a hardcoded
  light-canvas widget gets a light canvas on updated clients.
- Physical devices and WebKit were not part of this verification.

## Verification

`client/e2e/widget-theme-contrast.spec.ts` renders in Chromium for every
palette × saved theme × device preference: built-in classes and theme tokens,
the three categorical roles with eight distinct hues, and fixed light and dark
designs, colourless and theme-aware widgets under the default canvas rule.
