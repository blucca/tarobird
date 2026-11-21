import { Parser } from "htmlparser2";
import { Script } from "node:vm";
import { widgetInputSchema, type WidgetInput } from "../client-protocol/widget.js";

function checkScript(source: string, label: string, handler = false): void {
  const filename = "widget-check.js";
  try { new Script(handler ? `(function(event){\n${source}\n})` : source, { filename }); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // V8's message alone omits the location. Keep a small, source-local hint
    // in the existing invalid_widget receipt so the author can correct it.
    const match = /^widget-check\.js:(\d+)\b/m.exec(error.stack ?? "");
    const line = match ? Math.max(1, Number(match[1]) - (handler ? 1 : 0)) : undefined;
    const snippet = line ? source.split(/\r\n|\r|\n/)[line - 1]?.trim().slice(0, 160) : undefined;
    throw new SyntaxError(`${label}${line ? `, line ${line}` : ""}: ${error.message.slice(0, 300)}${snippet ? `\n${snippet}` : ""}`);
  }
}

const httpsUrl = (value: string | undefined) => { try { return !!value && new URL(value).protocol === "https:"; } catch { return false; } };
/** Parse classic scripts without executing model code. Only https may be referenced
 * externally; the renderer enforces the real resource/authority boundary. */
export function validateWidget(raw: unknown): WidgetInput {
  const widget = widgetInputSchema.parse(raw);
  if ("report" in widget) return widget;
  let script: string | undefined, scriptNumber = 0;
  const parser = new Parser({
    onopentag(name, attrs) {
      // External https stylesheets and scripts load only on clients that allow widget
      // network access; others ignore them and keep the static markup.
      if (name === "link" && !(attrs.rel?.trim().toLowerCase() === "stylesheet" && httpsUrl(attrs.href))) throw new Error("Widget <link> supports only rel=\"stylesheet\" with an https href");
      if (["iframe", "frame", "object", "embed", "base", "meta"].includes(name)) throw new Error(`Widget does not support <${name}>; use an HTML fragment`);
      for (const [attribute, value] of Object.entries(attrs)) {
        if (/^on[a-z]+$/i.test(attribute) && value.trim()) checkScript(value, `<${name}> ${attribute} handler`, true);
      }
      if (name === "script") {
        if (attrs.type && !["text/javascript", "application/javascript"].includes(attrs.type.toLowerCase())) throw new Error("Use classic JavaScript; modules are unavailable");
        if (attrs.src !== undefined && !httpsUrl(attrs.src)) throw new Error("External widget scripts must use an https URL");
        script = attrs.src !== undefined ? undefined : ""; if (script !== undefined) scriptNumber++;
      }
    },
    ontext(text) { if (script !== undefined) script += text; },
    onclosetag(name) { if (name === "script" && script !== undefined) { checkScript(script, `Widget script ${scriptNumber}`); script = undefined; } },
  });
  parser.write(widget.html); parser.end();
  return widget;
}
