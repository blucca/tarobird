import { Capacitor } from "@capacitor/core";

/**
 * The iOS App's WKWebView cannot undo a page zoom. Capacitor turns the page
 * pinch off (zoomEnabled defaults to false) and capacitor.config.ts turns the
 * scroll view off, yet WebKit still zooms into a focused text field or
 * contenteditable whose text is under 16px. The page then stays enlarged, with
 * its right and bottom edges (the screen viewer's close button among them) off
 * screen until the App restarts.
 *
 * A maximum scale of 1 stops that automatic zoom whichever control causes it.
 * It removes no gesture there, because the page pinch is already off; pictures,
 * PDFs and images keep the pinch zoom they handle themselves. Android, desktop
 * and browsers keep their viewport unchanged.
 */
export function withoutPageZoom(viewport: string): string {
  const kept = viewport.split(",").map(part => part.trim()).filter(part => part && !/^(maximum-scale|user-scalable)\s*=/i.test(part));
  return [...kept, "maximum-scale=1"].join(",");
}

export function lockIosAppPageZoom(platform: string = Capacitor.getPlatform(), root: Pick<Document, "querySelector"> = document): void {
  if (platform !== "ios") return;
  const meta = root.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = withoutPageZoom(meta.content);
}
