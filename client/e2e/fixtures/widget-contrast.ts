// Contrast probes for sandboxed widget guests. Runs inside the guest document:
// keep it self-contained (no imports, no closures over Node values).
export type ContrastTarget = { id: string; kind: "text" | "large" | "graphic"; paint?: "color" | "fill" | "stroke" | "background" };
export type ContrastResult = { id: string; kind: ContrastTarget["kind"]; fg: string; bg: string; ratio: number };

export function measureContrast(root: Element, targets: ContrastTarget[]): ContrastResult[] {
  type Rgba = { r: number; g: number; b: number; a: number };
  const parse = (value: string): Rgba | undefined => {
    const srgb = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.e-]+%?))?\)$/.exec(value.trim());
    if (srgb) return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255, a: srgb[4] === undefined ? 1 : srgb[4].endsWith("%") ? Number(srgb[4].slice(0, -1)) / 100 : Number(srgb[4]) };
    const rgb = /^rgba?\(([^)]+)\)$/.exec(value.trim());
    if (!rgb) return undefined;
    const parts = rgb[1]!.split(/[\s,/]+/).filter(Boolean).map(part => part.endsWith("%") ? Number(part.slice(0, -1)) / 100 : Number(part));
    return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
  };
  const over = (top: Rgba, base: Rgba): Rgba => ({ r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1 });
  const luminance = (c: Rgba) => [c.r, c.g, c.b].map(v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const hex = (c: Rgba) => "#" + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, "0")).join("");
  const backdrop = (node: Element): Rgba => {
    const layers: Rgba[] = [];
    for (let current: Element | null = node; current; current = current.parentElement) {
      const layer = parse(getComputedStyle(current).backgroundColor);
      if (layer && layer.a > 0) { layers.push(layer); if (layer.a >= 1) break; }
    }
    let base: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    for (let index = layers.length - 1; index >= 0; index--) base = over(layers[index]!, base);
    return base;
  };
  return targets.map(target => {
    const node = root.querySelector("#" + target.id);
    if (!node) return { id: target.id, kind: target.kind, fg: "missing", bg: "missing", ratio: 0 };
    const style = getComputedStyle(node);
    const paint = target.paint ?? (node instanceof SVGElement ? "fill" : "color");
    const painted = paint === "color" ? style.color : paint === "fill" ? style.fill : paint === "stroke" ? style.stroke : style.backgroundColor, raw = parse(painted);
    const background = backdrop(target.kind === "graphic" && node.parentElement ? node.parentElement : node);
    if (!raw) return { id: target.id, kind: target.kind, fg: String(painted), bg: hex(background), ratio: 0 };
    const foreground = over(raw, background);
    const a = luminance(foreground), b = luminance(background);
    return { id: target.id, kind: target.kind, fg: hex(foreground), bg: hex(background), ratio: Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100 };
  });
}

export function guestThemeSnapshot(html: HTMLElement): Record<string, string> {
  const names = ["text", "muted", "surface", "card", "border", "accent", "primary-bg", "on-primary", "chart-series-1", "chart-series-2", "chart-series-3", "chart-series-4"];
  const out: Record<string, string> = {};
  for (const name of names) out[name] = html.style.getPropertyValue("--" + name).trim();
  out.colorScheme = html.style.colorScheme;
  out.prefersDark = String(matchMedia("(prefers-color-scheme: dark)").matches);
  out.htmlBackground = getComputedStyle(html).backgroundColor;
  return out;
}
