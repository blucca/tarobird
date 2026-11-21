# iOS App page zoom that could not be undone

On an iPhone the whole App page was found enlarged by about 1.089 and stayed
that way until restart: `innerWidth` was 395 while the layout was 430 wide, so
the right 35 pt and bottom 76 pt, including the screen viewer's close button,
were off screen. The preceding touch was not observed.

## Cause

WebKit zooms the page into a focused text field whose computed font is under
16 px; the scale is about 16 / font size, so 1.089 corresponds to a 14.7 px
field. A contenteditable behaves the same. In a browser the person pinches back
out. The App's WKWebView cannot: Capacitor's default `zoomEnabled: false`
disables the page pinch recognizer as a pinch begins, and `capacitor.config.ts`
turns scrolling off. Leaving the field does not reset the scale.

The phone input floor in `viewport.css` (specificity 0,1,2) protects most
fields, but two-class rules such as `.workbench-library .workbench-library-search
input` (13 px) outrank it on iPhone. The stronger iOS floor in
`ios-adaptive.css` only applies above 760 px with a fine pointer. Floors also do
not reach contenteditable surfaces or framed documents, so a size-only repair
would recur with the next such control.

## Change

`main.tsx` calls `lockIosAppPageZoom()` from `ios-page-zoom.ts` after the
platform is known. When Capacitor reports `ios` it adds `maximum-scale=1` to the
existing viewport content (replacing any earlier scale limit). WebKit then has
no scale to zoom to, whichever control is focused. This removes no gesture in
the App because the page pinch was already disabled. The screen picture, PDF
and image viewers implement their own pinch handling and are unaffected.
Android, desktop (Capacitor `web`) and browsers keep the shipped viewport.
App presentation only; Host, engine adapters and the headless CLI are
unchanged.

## Verification

An isolated WKWebView in the iOS 27.1 simulator mirrored the App's scroll-view
setup (no scrolling, no bounce, no inset adjustment, Capacitor's pinch guard)
and received real XCUITest touches:

| Touch (before) | Scale after leaving the field | Pinch out |
| --- | --- | --- |
| 13 px input, textarea or contenteditable | 1.2318 | stays 1.2318 |
| 14.7 px input | 1.0880 | stays 1.0880 |
| 16 px input; 13 px `select` (this runtime) | 1 | — |

Without Capacitor's pinch guard, pinching out brought the same zooms back to
1.0000 and 1.0097, so the guard is what keeps them. With the change every row stays at scale 1 and
`innerWidth` equals the layout width. Viewer runs with production CSS kept scale
1 through the quality and display pickers, the keyboard tray, double taps and a
page pinch, before and after; the picture's own pinch still zoomed it to 4× and
back out to 2.05×. The close button stayed on screen except while the tray keyboard was
open, when the page lifted it 51 pt above the top in both runs; the probe lacks
the App's native keyboard plugin.

`client/tests/ios-page-zoom.test.ts` and `client/e2e/ios-page-zoom.spec.ts`
(real `index.html` and `main.tsx` startup in Chromium) fail when the call or the
iOS branch is removed. A physical iPhone, iPad and the exact preceding touch are
not covered.
