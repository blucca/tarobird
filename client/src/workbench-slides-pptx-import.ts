import { unzipSync } from "fflate";
import { designTextFile, encodeDesignFile, validateDesignDocument, type DesignDocument, type DesignFile } from "./workbench-design.js";

/** Limits for untrusted .pptx uploads (zip-bomb and memory safety). */
const MAX_PPTX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_PPTX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_PPTX_ENTRIES = 512;
const MAX_SLIDES = 200;
const EMU_PER_PT = 12700;

type RelMap = Map<string, { target: string; type: string }>;
type ThemeColors = Record<string, string>;

const DEFAULT_THEME_COLORS: ThemeColors = {
  dk1: "#1a1a1a",
  lt1: "#ffffff",
  dk2: "#334155",
  lt2: "#f8fafc",
  tx1: "#1a1a1a",
  bg1: "#ffffff",
  tx2: "#475569",
  bg2: "#f1f5f9",
  accent1: "#2563eb",
  accent2: "#0f766e",
  accent3: "#d97706",
  accent4: "#7c3aed",
  accent5: "#dc2626",
  accent6: "#0891b2",
};

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, "i").exec(tag);
  return m ? decodeXmlEntities(m[1]!) : undefined;
}

function normalizeZipPath(baseDir: string, target: string): string {
  const clean = target.replace(/^\/+/, "");
  const parts = (target.startsWith("/") ? clean : `${baseDir}/${clean}`).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function parseRels(xml: string | undefined): RelMap {
  const map: RelMap = new Map();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const attrs = m[1] ?? "";
    const id = attr(attrs, "Id");
    const target = attr(attrs, "Target");
    const type = attr(attrs, "Type") ?? "";
    if (id && target) map.set(id, { target, type });
  }
  return map;
}

function parseThemeColors(xml: string | undefined): ThemeColors {
  const colors: ThemeColors = { ...DEFAULT_THEME_COLORS };
  if (!xml) return colors;
  const clrScheme = /<a:clrScheme\b[^>]*>([\s\S]*?)<\/a:clrScheme>/.exec(xml)?.[1];
  if (!clrScheme) return colors;
  for (const key of ["dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6"]) {
    const block = new RegExp(`<a:${key}\\b[^>]*>([\\s\\S]*?)<\\/a:${key}>`).exec(clrScheme)?.[1];
    if (!block) continue;
    const srgb = /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
    const sys = /<a:sysClr\b[^>]*lastClr="([0-9A-Fa-f]{6})"/.exec(block)?.[1];
    const hex = srgb ?? sys;
    if (hex) colors[key] = `#${hex}`;
  }
  colors.tx1 = colors.dk1;
  colors.bg1 = colors.lt1;
  colors.tx2 = colors.dk2;
  colors.bg2 = colors.lt2;
  return colors;
}

function extractColor(xml: string | undefined, theme: ThemeColors): string | undefined {
  if (!xml) return undefined;
  const srgb = /<a:srgbClr\b[^>]*val="([0-9A-Fa-f]{6})"/.exec(xml)?.[1];
  if (srgb) return `#${srgb}`;
  const scheme = /<a:schemeClr\b[^>]*val="([^"]+)"/.exec(xml)?.[1];
  if (scheme && theme[scheme]) return theme[scheme];
  return undefined;
}

function extractSolidFill(xml: string | undefined, theme: ThemeColors): string | undefined {
  if (!xml) return undefined;
  const solid = /<a:solidFill\b[^>]*>([\s\S]*?)<\/a:solidFill>/.exec(xml)?.[1];
  return extractColor(solid, theme);
}

/** Extract top-level blocks matching `<tagName ...>...</tagName>` (handles nesting). */
function extractTagBlocks(xml: string, tagName: string): string[] {
  const results: string[] = [];
  const openRe = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
  const closeStr = `</${tagName}>`;
  let pos = 0;
  while (pos < xml.length) {
    openRe.lastIndex = pos;
    const start = openRe.exec(xml);
    if (!start) break;
    if (start[0].endsWith("/>")) {
      results.push(start[0]);
      pos = start.index + start[0].length;
      continue;
    }
    let depth = 1;
    let cursor = start.index + start[0].length;
    while (depth > 0 && cursor < xml.length) {
      openRe.lastIndex = cursor;
      const nextOpen = openRe.exec(xml);
      const nextClose = xml.indexOf(closeStr, cursor);
      if (nextClose < 0) break;
      if (nextOpen && nextOpen.index < nextClose && !nextOpen[0].endsWith("/>")) {
        depth++;
        cursor = nextOpen.index + nextOpen[0].length;
      } else {
        depth--;
        cursor = nextClose + closeStr.length;
      }
    }
    results.push(xml.slice(start.index, cursor));
    pos = cursor;
  }
  return results;
}

interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
  rot?: number;
}

function extractXfrm(xml: string, scaleX: number, scaleY: number): BoxRect | undefined {
  const xfrm = /<(?:a|p):xfrm\b([^>]*)>([\s\S]*?)<\/(?:a|p):xfrm>/.exec(xml);
  if (!xfrm) return undefined;
  const attrs = xfrm[1] ?? "";
  const inner = xfrm[2] ?? "";
  const offTag = /<a:off\b([^>]*)\/?>/.exec(inner)?.[1];
  const extTag = /<a:ext\b([^>]*)\/?>/.exec(inner)?.[1];
  if (!offTag || !extTag) return undefined;
  const x = Number(attr(offTag, "x") ?? 0);
  const y = Number(attr(offTag, "y") ?? 0);
  const cx = Number(attr(extTag, "cx") ?? 0);
  const cy = Number(attr(extTag, "cy") ?? 0);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0) return undefined;
  const rotRaw = Number(attr(attrs, "rot") ?? 0);
  const rot = Number.isFinite(rotRaw) && rotRaw !== 0 ? Math.round((rotRaw / 60000) * 10) / 10 : undefined;
  return {
    x: Math.round(x * scaleX),
    y: Math.round(y * scaleY),
    w: Math.max(8, Math.round(cx * scaleX)),
    h: Math.max(8, Math.round(cy * scaleY)),
    ...(rot ? { rot } : {}),
  };
}

interface ParsedRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSizePx?: number;
  fontFamily?: string;
}

interface ParsedParagraph {
  runs: ParsedRun[];
  align?: "left" | "center" | "right" | "justify";
  bullet?: "ul" | "ol";
}

function parseParagraphs(txBodyXml: string, theme: ThemeColors, ptToPx: number): ParsedParagraph[] {
  const out: ParsedParagraph[] = [];
  for (const pXml of extractTagBlocks(txBodyXml, "a:p")) {
    const pPrMatch = /<a:pPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:pPr>)/.exec(pXml);
    const pPrAttrs = pPrMatch?.[1] ?? "";
    const pPrBody = pPrMatch?.[2] ?? "";
    const algn = attr(pPrAttrs, "algn");
    const align = algn === "ctr" ? "center" : algn === "r" ? "right" : algn === "just" ? "justify" : undefined;
    const hasBuNone = /<a:buNone\b/.test(pPrBody);
    const hasBuAuto = !hasBuNone && /<a:buAutoNum\b/.test(pPrBody);
    const hasBuChar = !hasBuNone && /<a:buChar\b/.test(pPrBody);
    const bullet = hasBuAuto ? "ol" : hasBuChar ? "ul" : undefined;

    const runs: ParsedRun[] = [];
    for (const token of pXml.matchAll(/<a:r\b[^>]*>([\s\S]*?)<\/a:r>|<a:br\b[^>]*\/?>/g)) {
      if (token[0].startsWith("<a:br")) {
        runs.push({ text: "\n" });
        continue;
      }
      const rXml = token[1] ?? "";
      const textMatch = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/.exec(rXml);
      if (!textMatch) continue;
      const text = decodeXmlEntities(textMatch[1]!);
      if (!text) continue;
      const rPrMatch = /<a:rPr\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:rPr>)/.exec(rXml);
      const rPrAttrs = rPrMatch?.[1] ?? "";
      const rPrBody = rPrMatch?.[2] ?? "";
      const sz = Number(attr(rPrAttrs, "sz") ?? 0);
      const fontSizePx = sz > 0 ? Math.max(12, Math.min(200, Math.round((sz / 100) * ptToPx))) : undefined;
      const bold = attr(rPrAttrs, "b") === "1" || attr(rPrAttrs, "b") === "true";
      const italic = attr(rPrAttrs, "i") === "1" || attr(rPrAttrs, "i") === "true";
      const u = attr(rPrAttrs, "u");
      const underline = !!u && u !== "none";
      const color = extractSolidFill(rPrBody, theme);
      const latin = /<a:latin\b[^>]*typeface="([^"]+)"/.exec(rPrBody)?.[1];
      const ea = /<a:ea\b[^>]*typeface="([^"]+)"/.exec(rPrBody)?.[1];
      const fontFamily = (latin && !latin.startsWith("+") ? latin : undefined) ?? (ea && !ea.startsWith("+") ? ea : undefined);
      runs.push({ text, bold, italic, underline, color, fontSizePx, fontFamily });
    }
    if (runs.length > 0) out.push({ runs, align, bullet });
  }
  return out;
}

function renderRunHtml(run: ParsedRun, defaultColor?: string): string {
  if (run.text === "\n") return "<br>";
  let html = escapeHtml(run.text);
  if (run.underline) html = `<u>${html}</u>`;
  if (run.italic) html = `<i>${html}</i>`;
  if (run.bold) html = `<b>${html}</b>`;
  if (run.color && run.color !== defaultColor) {
    html = `<span style="color:${run.color}">${html}</span>`;
  }
  return html;
}

function mediaContentType(path: string): string | undefined {
  const ext = path.toLowerCase().split(".").pop();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "svg") return "image/svg+xml";
  return undefined;
}

function positionStyle(box: BoxRect): string {
  const parts = [
    "position:absolute",
    `left:${box.x}px`,
    `top:${box.y}px`,
    `width:${box.w}px`,
    `height:${box.h}px`,
  ];
  if (box.rot) parts.push(`transform:rotate(${box.rot}deg)`);
  return parts.join(";");
}

function renderShapeHtml(spXml: string, scaleX: number, scaleY: number, ptToPx: number, theme: ThemeColors): string | undefined {
  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(spXml)?.[1] ?? "";
  const box = extractXfrm(spPr, scaleX, scaleY);
  const txBody = /<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/.exec(spXml)?.[1];
  const paragraphs = txBody ? parseParagraphs(txBody, theme, ptToPx) : [];
  const bg = extractSolidFill(spPr, theme);
  const lnBlock = /<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/.exec(spPr);
  const lnColor = lnBlock ? extractSolidFill(lnBlock[2], theme) : undefined;
  const lnW = lnBlock ? Number(attr(lnBlock[1] ?? "", "w") ?? 0) : 0;
  const borderWidth = lnColor ? Math.max(1, Math.round((lnW / EMU_PER_PT) * ptToPx)) : 0;
  const prst = /<a:prstGeom\b[^>]*prst="([^"]+)"/.exec(spPr)?.[1];
  const phType = /<p:ph\b[^>]*type="([^"]+)"/.exec(spXml)?.[1];

  if (!box && paragraphs.length === 0) return undefined;
  const effectiveBox: BoxRect = box ?? { x: 120, y: 120, w: 1680, h: 160 };

  const shapeStyles: string[] = [positionStyle(effectiveBox), "box-sizing:border-box"];
  if (bg) shapeStyles.push(`background:${bg}`);
  if (lnColor && borderWidth > 0) shapeStyles.push(`border:${borderWidth}px solid ${lnColor}`);
  if (prst === "ellipse") shapeStyles.push("border-radius:50%");
  else if (prst === "roundRect") shapeStyles.push("border-radius:16px");

  // Pure decorative shape without text
  if (paragraphs.length === 0) {
    if (!bg && !lnColor) return undefined;
    return `  <div style="${shapeStyles.join(";")}"></div>`;
  }

  const firstRun = paragraphs[0]?.runs.find(r => r.text.trim());
  const defaultColor = firstRun?.color;
  const defaultSize = firstRun?.fontSizePx ?? (phType === "title" || phType === "ctrTitle" ? 72 : phType === "subTitle" ? 40 : 32);
  const defaultFont = firstRun?.fontFamily;
  const allBullets = paragraphs.length > 0 && paragraphs.every(p => p.bullet === paragraphs[0]!.bullet && p.bullet !== undefined);

  if (paragraphs.length === 1 && !paragraphs[0]!.bullet && !bg && !lnColor) {
    const p = paragraphs[0]!;
    const tag = phType === "title" || phType === "ctrTitle" || defaultSize >= 64 ? "h1" : defaultSize >= 44 ? "h2" : "p";
    const styles = [
      ...shapeStyles,
      `font-size:${defaultSize}px`,
      "margin:0",
      "line-height:1.25",
    ];
    if (defaultColor) styles.push(`color:${defaultColor}`);
    if (defaultFont) styles.push(`font-family:${escapeHtml(defaultFont)}`);
    if (p.align) styles.push(`text-align:${p.align}`);
    const inner = p.runs.map(r => renderRunHtml(r, defaultColor)).join("");
    return `  <${tag} style="${styles.join(";")}">${inner}</${tag}>`;
  }

  if (allBullets && !bg && !lnColor) {
    const listTag = paragraphs[0]!.bullet!;
    const styles = [
      ...shapeStyles,
      `font-size:${defaultSize}px`,
      "margin:0",
      "padding-left:40px",
      "line-height:1.4",
    ];
    if (defaultColor) styles.push(`color:${defaultColor}`);
    if (defaultFont) styles.push(`font-family:${escapeHtml(defaultFont)}`);
    const items = paragraphs.map(p => `    <li>${p.runs.map(r => renderRunHtml(r, defaultColor)).join("")}</li>`).join("\n");
    return `  <${listTag} style="${styles.join(";")}">\n${items}\n  </${listTag}>`;
  }

  // Multi-paragraph or boxed text container
  const boxStyles = [
    ...shapeStyles,
    "display:flex",
    "flex-direction:column",
    "gap:12px",
    "padding:16px",
    `font-size:${defaultSize}px`,
    "line-height:1.35",
  ];
  if (defaultColor) boxStyles.push(`color:${defaultColor}`);
  if (defaultFont) boxStyles.push(`font-family:${escapeHtml(defaultFont)}`);

  const children: string[] = [];
  let i = 0;
  while (i < paragraphs.length) {
    const p = paragraphs[i]!;
    if (p.bullet) {
      const kind = p.bullet;
      const group: ParsedParagraph[] = [];
      while (i < paragraphs.length && paragraphs[i]!.bullet === kind) {
        group.push(paragraphs[i]!);
        i++;
      }
      const items = group.map(item => `      <li>${item.runs.map(r => renderRunHtml(r, defaultColor)).join("")}</li>`).join("\n");
      children.push(`    <${kind} style="margin:0;padding-left:36px">\n${items}\n    </${kind}>`);
    } else {
      const pStyle = [
        "margin:0",
        ...(p.align ? [`text-align:${p.align}`] : []),
        ...(p.runs[0]?.fontSizePx && p.runs[0].fontSizePx !== defaultSize ? [`font-size:${p.runs[0].fontSizePx}px`] : []),
      ].join(";");
      children.push(`    <p style="${pStyle}">${p.runs.map(r => renderRunHtml(r, defaultColor)).join("")}</p>`);
      i++;
    }
  }
  return `  <div data-text style="${boxStyles.join(";")}">\n${children.join("\n")}\n  </div>`;
}

function renderTableHtml(frameXml: string, scaleX: number, scaleY: number, ptToPx: number, theme: ThemeColors): string | undefined {
  const tblXml = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/.exec(frameXml)?.[1];
  if (!tblXml) return undefined;
  const rows = extractTagBlocks(tblXml, "a:tr");
  if (rows.length === 0) return undefined;
  const box = extractXfrm(frameXml, scaleX, scaleY) ?? { x: 120, y: 200, w: 1680, h: 500 };
  const trHtml: string[] = [];
  rows.forEach((trXml, rowIndex) => {
    const cells = extractTagBlocks(trXml, "a:tc");
    const tdHtml = cells.map(tcXml => {
      const txBody = /<a:txBody\b[^>]*>([\s\S]*?)<\/a:txBody>/.exec(tcXml)?.[1];
      const tcPr = /<a:tcPr\b[^>]*>([\s\S]*?)<\/a:tcPr>/.exec(tcXml)?.[1];
      const cellBg = extractSolidFill(tcPr, theme);
      const paragraphs = txBody ? parseParagraphs(txBody, theme, ptToPx) : [];
      const text = paragraphs.map(p => p.runs.map(r => renderRunHtml(r)).join("")).join("<br>");
      const cellTag = rowIndex === 0 ? "th" : "td";
      const cellStyle = [
        "padding:14px 18px",
        "border:1px solid #d1d5db",
        "text-align:left",
        ...(cellBg ? [`background:${cellBg}`] : rowIndex === 0 ? ["background:#f3f4f6"] : []),
      ].join(";");
      return `        <${cellTag} style="${cellStyle}">${text}</${cellTag}>`;
    });
    trHtml.push(`      <tr>\n${tdHtml.join("\n")}\n      </tr>`);
  });
  return `  <div style="${positionStyle(box)};overflow:hidden">\n    <table style="width:100%;height:100%;border-collapse:collapse;font-size:26px;color:#1a1a1a">\n${trHtml.join("\n")}\n    </table>\n  </div>`;
}

function renderPictureHtml(
  picXml: string,
  slideRels: RelMap,
  slideDir: string,
  entries: Record<string, Uint8Array>,
  assets: Record<string, DesignFile>,
  scaleX: number,
  scaleY: number,
): string | undefined {
  const embedId = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(picXml)?.[1];
  if (!embedId) return undefined;
  const rel = slideRels.get(embedId);
  if (!rel) return undefined;
  const mediaPath = normalizeZipPath(slideDir, rel.target);
  const bytes = entries[mediaPath];
  const contentType = mediaContentType(mediaPath);
  if (!bytes || !contentType) return undefined;

  const encoded = encodeDesignFile(bytes, contentType);
  const assetId = encoded.sha256.slice(0, 32);
  const assetPath = `project/assets/${assetId}`;
  if (!assets[assetPath]) assets[assetPath] = encoded;

  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(picXml)?.[1] ?? "";
  const box = extractXfrm(spPr, scaleX, scaleY) ?? { x: 160, y: 160, w: 640, h: 480 };
  const cNvPr = /<p:cNvPr\b([^>]*)\/?>/.exec(picXml)?.[1] ?? "";
  const alt = escapeHtml(attr(cNvPr, "descr") ?? attr(cNvPr, "name") ?? "Image");
  return `  <img src="/_blob/${assetId}" alt="${alt}" style="${positionStyle(box)};object-fit:contain">`;
}

function extractNotesText(notesXml: string | undefined, theme: ThemeColors): string {
  if (!notesXml) return "";
  const parts: string[] = [];
  for (const spXml of extractTagBlocks(notesXml, "p:sp")) {
    const phType = /<p:ph\b[^>]*type="([^"]+)"/.exec(spXml)?.[1];
    if (phType && phType !== "body") continue;
    const txBody = /<p:txBody\b[^>]*>([\s\S]*?)<\/p:txBody>/.exec(spXml)?.[1];
    if (!txBody) continue;
    for (const p of parseParagraphs(txBody, theme, 1)) {
      const line = p.runs.map(r => r.text).join("").trim();
      if (line) parts.push(line);
    }
  }
  return parts.join("\n");
}

function decodeUtf8(bytes: Uint8Array | undefined): string | undefined {
  return bytes ? new TextDecoder("utf-8", { fatal: false }).decode(bytes) : undefined;
}

/**
 * Converts a PowerPoint `.pptx` binary archive into an editable Workbench
 * Presentation (`project/deck.json` v4 + `project/slides/*.html` + embedded
 * `project/assets/*` images).
 */
export function importPptxToSlides(archiveBytes: Uint8Array, options: { id: string; title?: string }): DesignDocument {
  if (!(archiveBytes instanceof Uint8Array) || archiveBytes.byteLength === 0 || archiveBytes.byteLength > MAX_PPTX_ARCHIVE_BYTES) {
    throw new Error("design_invalid_import");
  }
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archiveBytes);
  } catch {
    throw new Error("design_invalid_import");
  }
  const names = Object.keys(entries);
  if (names.length === 0 || names.length > MAX_PPTX_ENTRIES) throw new Error("design_invalid_import");
  let totalUncompressed = 0;
  for (const name of names) {
    if (name.includes("..") || name.startsWith("/")) throw new Error("design_invalid_import");
    totalUncompressed += entries[name]!.byteLength;
    if (totalUncompressed > MAX_PPTX_UNCOMPRESSED_BYTES) throw new Error("design_invalid_import");
  }

  const presentationXml = decodeUtf8(entries["ppt/presentation.xml"]);
  if (!presentationXml) throw new Error("design_invalid_import");
  const presentationRels = parseRels(decodeUtf8(entries["ppt/_rels/presentation.xml.rels"]));

  // Slide size in EMUs (default widescreen 16:9: 12192000 x 6858000 = 960pt x 540pt)
  const sldSzTag = /<p:sldSz\b([^>]*)\/?>/.exec(presentationXml)?.[1] ?? "";
  const cxEmu = Number(attr(sldSzTag, "cx") ?? 12192000) || 12192000;
  const cyEmu = Number(attr(sldSzTag, "cy") ?? 6858000) || 6858000;
  const aspect = cxEmu / cyEmu;
  const is43 = Math.abs(aspect - 4 / 3) < 0.15;
  const targetW = is43 ? 1440 : 1920;
  const targetH = 1080;
  const scaleX = targetW / cxEmu;
  const scaleY = targetH / cyEmu;
  const ptToPx = targetH / (cyEmu / EMU_PER_PT);

  const theme = parseThemeColors(decodeUtf8(entries["ppt/theme/theme1.xml"]));

  // Resolve slide paths in deck order
  const slidePaths: string[] = [];
  for (const m of presentationXml.matchAll(/<p:sldId\b([^>]*)\/?>/g)) {
    const rId = attr(m[1] ?? "", "r:id");
    const rel = rId ? presentationRels.get(rId) : undefined;
    if (!rel) continue;
    const resolved = normalizeZipPath("ppt", rel.target);
    if (entries[resolved]) slidePaths.push(resolved);
  }
  if (slidePaths.length === 0) {
    // Fallback: sorted ppt/slides/slide*.xml
    const found = names
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
    slidePaths.push(...found);
  }
  if (slidePaths.length === 0 || slidePaths.length > MAX_SLIDES) throw new Error("design_invalid_import");

  const files: Record<string, DesignFile> = {};
  const order: string[] = [];

  for (let idx = 0; idx < slidePaths.length; idx++) {
    const slidePath = slidePaths[idx]!;
    const slideXml = decodeUtf8(entries[slidePath]);
    if (!slideXml) continue;
    const slideId = `slide-${idx + 1}`;
    order.push(slideId);

    const slash = slidePath.lastIndexOf("/");
    const slideDir = slash >= 0 ? slidePath.slice(0, slash) : "";
    const slideFile = slash >= 0 ? slidePath.slice(slash + 1) : slidePath;
    const slideRels = parseRels(decodeUtf8(entries[`${slideDir}/_rels/${slideFile}.rels`]));

    const bgBlock = /<p:bg\b[^>]*>([\s\S]*?)<\/p:bg>/.exec(slideXml)?.[1];
    const bgColor = extractSolidFill(bgBlock, theme) ?? "#ffffff";
    const elements: string[] = [];

    const spTree = /<p:spTree\b[^>]*>([\s\S]*?)<\/p:spTree>/.exec(slideXml)?.[1] ?? slideXml;
    for (const spXml of extractTagBlocks(spTree, "p:sp")) {
      const rendered = renderShapeHtml(spXml, scaleX, scaleY, ptToPx, theme);
      if (rendered) elements.push(rendered);
    }
    for (const frameXml of extractTagBlocks(spTree, "p:graphicFrame")) {
      const rendered = renderTableHtml(frameXml, scaleX, scaleY, ptToPx, theme);
      if (rendered) elements.push(rendered);
    }
    for (const picXml of extractTagBlocks(spTree, "p:pic")) {
      const rendered = renderPictureHtml(picXml, slideRels, slideDir, entries, files, scaleX, scaleY);
      if (rendered) elements.push(rendered);
    }

    // Optional speaker notes
    let notes = "";
    for (const rel of slideRels.values()) {
      if (rel.type.endsWith("/notesSlide")) {
        const notesPath = normalizeZipPath(slideDir, rel.target);
        notes = extractNotesText(decodeUtf8(entries[notesPath]), theme);
        break;
      }
    }

    const lines = [
      `<section id="${slideId}" style="position:relative;background:${bgColor};color:#1a1a1a;font-family:Arial,sans-serif">`,
      ...elements,
      ...(notes ? ["  <aside>", `    ${escapeHtml(notes).replace(/\n/g, "\n    ")}`, "  </aside>"] : []),
      "</section>",
      "",
    ];
    files[`project/slides/${slideId}.html`] = designTextFile(lines.join("\n"), "text/html");
  }

  const title = (options.title ?? "").trim().replace(/\.pptx$/i, "").slice(0, 128) || "Presentation";
  const deckIndex = {
    v: 4,
    createdOnFiles: { v: 1, at: new Date().toISOString() },
    lists: "css",
    title,
    ...(is43 ? { size: "4:3" } : {}),
    cover: order[0],
    order,
    sections: {},
    faces: {},
    designSystems: [],
    attachments: {},
  };
  files["project/deck.json"] = designTextFile(JSON.stringify(deckIndex, null, 2) + "\n", "application/json");

  return validateDesignDocument({
    schema: 1,
    format: "slides",
    id: options.id,
    revision: 0,
    receipts: [],
    files,
  });
}
