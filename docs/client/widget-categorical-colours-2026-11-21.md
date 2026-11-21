# Categorical widget colours and declared canvases

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
mode. CLI's light set only serves a declared light canvas. Each palette leads
with its own hue while the first two slots stay one cool and one warm. Soft
tints are mixed into the palette's reading surface. App chrome, chat and
semantic status colours do not use these tokens. `--chart-series-1..4` are
unchanged.

`widgetTheme` passes the current roles plus the palette's `-light`/`-dark`
sets and neutral light/dark canvas tokens (Monochrome's own values).

A widget whose outermost element declares `data-canvas-theme="light"` or
`"dark"` is shown on that canvas in every App theme: when the declaration
differs from the App scheme, the viewer applies that scheme's tokens and
`color-scheme`, and the Worker receives the same effective theme (so
`matchMedia('(prefers-color-scheme: dark)')`, `light-dark()` and authored
`@media (prefers-color-scheme)` agree). Authored colours are never rewritten.
Nested or unknown values are ignored.

The authoring guidance now encourages colour per category, metric and series,
lists the guaranteed pairings with a short example, forbids text on solid
`--cat-N`, names SVG text's default black fill and black/white `rgba` tints,
asks for `light-dark()` for any extra colour, and reserves `data-canvas-theme`
for designs that depend on one canvas. `--ok/--warn/--danger` keep their
meanings and colour must not be the only cue.

## Compatibility

- No protocol, persisted data, sandbox permission or frozen native tool
  definition changes. The headless CLI shares the guidance; no new command.
- Older clients do not define `--cat-*`; widgets that rely on them lose those
  fills there. Historical widgets keep their own colours; a hardcoded
  light-canvas widget becomes readable only if it declares a canvas.
- Physical devices and WebKit were not part of this verification.

## Verification

`client/e2e/widget-theme-contrast.spec.ts` renders in Chromium for every
palette × saved theme × device preference: built-in classes and theme tokens,
the three categorical roles with eight distinct hues, and declared light and
dark canvases with fixed authored colours and a scripted scheme probe.
