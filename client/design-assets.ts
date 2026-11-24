import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { buildSync } from "esbuild";
import type { DesignFormat } from "../src/client-protocol/workbench-design.js";
import { designWheelDelta } from "./src/design-wheel.js";
import { DESIGN_BOOTSTRAP_URL } from "./electron/design-document.mjs";

const escapeScript = (text: string) => text.replace(/<\/script/gi, "<\\/script");

/** Upstream slides editor is pinned, byte checked and kept intact. Adapt only its
 * host entry points at build time, inside an opaque-origin editor, never the App document. */
export function buildDesignSandbox(format: DesignFormat = "slides"): string {
  if (format !== "slides") throw new Error("design_canvas_removed");
  const root = new URL("./vendor/baoyu-slides/", import.meta.url);
  const read = (name: string) => readFileSync(new URL(name, root), "utf8");
  const manifest = JSON.parse(read("UPSTREAM.json"));
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (createHash("sha256").update(readFileSync(new URL(name, root))).digest("hex") !== expected) throw new Error(`design_upstream_changed:${name}`);
  }
  const page = read("editor/index.html");
  const script = [...page.matchAll(/src="\.\/([^"]+\.js)"/g)].at(-1)![1], css = page.match(/href="\.\/([^"]+\.css)"/)![1];
  let js = read("editor/" + script);
  const patch = (from: string, to: string) => { if (js.split(from).length !== 2) throw new Error("design_adapter_contract_changed:" + from.slice(0, 100)); js = js.replace(from, to); };
  patch('authorName:su,agent:!0,working:F,footnote:F==="queued"?"Waiting for the agent":"Working…"',
    'authorName:"Bot",agent:!0,footnote:F==="queued"?"Draft ready":"Sent to Bot"');
  const wheel = `(${designWheelDelta.toString()})`;
  patch('canAsk:!Ma||ca?.mayEdit===!0', 'canAsk:window.__tarobirdDesignRepairEnabled&&(!Ma||ca?.mayEdit===!0)');
  patch('d=(0,e.formatMessage)({defaultMessage:"Someone who can edit this presentation can ask the agent to fix the slide.",id:"6E4gKJHZfQ"})',
    'd=window.__tarobirdDesignRepairEnabled?(0,e.formatMessage)({defaultMessage:"Someone who can edit this presentation can ask the agent to fix the slide.",id:"6E4gKJHZfQ"}):""');
  patch('ka.jsx(RW,{controller:e,state:t})', 'null');
  patch('let Xe=ue.deltaMode===1?16:ue.deltaMode===2?window.innerHeight:1,vt=ue.deltaMode===1?16:ue.deltaMode===2?window.innerWidth:1;if(Be==="zoom"){let{sx:Vt,sy:Re}=Q(ue.clientX,ue.clientY);M.setView(E(M.getView(),Vt,Re,A(ue.deltaY*Xe),M.limits))}else M.setView(S(M.getView(),-ue.deltaX*vt,-ue.deltaY*Xe))',
    `let delta=${wheel}(ue,g.clientWidth,g.clientHeight);if(Be==="zoom"){let{sx:Vt,sy:Re}=Q(ue.clientX,ue.clientY);M.setView(E(M.getView(),Vt,Re,Math.exp(delta.zoomLog),M.limits))}else M.setView(S(M.getView(),-delta.dx,-delta.dy))`);
  patch('fG({localComments:e=>fK({base:e,toolbar:!0}),room:yG,clashes:kG,mergeText:LG});d9();export{Sv as a,hK as g};', 'fG({base:"https://design.invalid/",localComments:e=>fK({base:e,toolbar:!0}),room:yG});window.slidesHost.downloads={save:window.__tarobotDesignSave};window.slidesHost.chat={suggestPrompt:window.__tarobotDesignSuggest};d9();');
  patch('f=c?null:e.localComments?.(r)??null,d=c??f?.link??null', 'f=e.localComments?.(r)??null,d=f?.link??null');
  patch('s=d?q9(d,f?.pins??W9(t.document)):null,h=c?h9(c):null', 's=d?q9(d,f?.pins??W9(t.document)):null,h=null');
  patch('flushForUnload:Wo,settle:async()=>{await ya(),await V,await ya(),await pt.settle()}', 'flushForUnload:Wo,settle:window.__tarobotDesignSettle=async()=>{await ya(),await V,await ya(),await pt.settle()}');
  patch('const M=await yA(t,n);c.post({type:"editor:flushed",requestId:x.requestId,saved:M})', 'let M=false;try{await t.__tarobotDesignSettle?.();M=await yA(t,n)}catch{}c.post({type:"editor:flushed",requestId:x.requestId,saved:M})');
  patch('import("./woff2-decoder-ZKHvEj5x.js")', 'import(window.__tarobotDesignResource("assets/woff2-decoder-ZKHvEj5x.js"))');
  patch('return Te.asset!==void 0?ca.get(Te.asset):Te.src', 'return window.__tarobotDesignAssets(Te.asset!==void 0?ca.get(Te.asset):Te.src)');
  patch('import.meta.url', '"https://design.invalid/"');

  const resources: Record<string, { type: string; base64: string }> = {};
  for (const name of Object.keys(manifest.files)) if (name.startsWith("editor/") && !name.startsWith("editor/node/") && name !== "editor/share-ui.js") {
    resources[name.slice(7)] = { type: name.endsWith(".js") ? "text/javascript" : name.endsWith(".json") ? "application/json" : name.endsWith(".woff2") ? "font/woff2" : name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/plain", base64: readFileSync(new URL(name, root)).toString("base64") };
  }
  delete resources[script]; delete resources[css];
  const style = read("editor/" + css).replace(/url\((?:["']?)([^)'" ]+\.woff2)(?:["']?)\)/g, (_all, name) => {
    const file = name.replace(/^\.\//, "").replace(/^\/assets\//, "assets/");
    const resource = resources[file] ?? resources[`assets/${file}`] ?? resources[`artifact-type/${file}`];
    if (!resource) throw new Error("design_font_missing:" + name);
    return `url(data:font/woff2;base64,${resource.base64})`;
  });
  const bridge = buildSync({ entryPoints: [fileURLToPath(new URL("./src/design-runtime.js", import.meta.url))], bundle: true, write: false, platform: "browser", format: "iife", globalName: "DesignRuntime", target: "es2022" }).outputFiles[0].text;
  return `<!doctype html><html lang="en" class="cds-root" data-density="comfortable"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src blob: data:; worker-src blob:; media-src blob: data:; frame-src blob: data:; base-uri https://design.invalid; form-action 'none'; object-src 'none'"><base href="https://design.invalid/"><meta name="viewport" content="width=device-width,initial-scale=1">${(page.match(/<meta name="appifact-capabilities"[^>]+>/) ?? [""])[0]}<title>PPT</title><style>${style}</style></head><body><div id="root"></div><script>${escapeScript(bridge)}\nDesignRuntime.startDesignRuntime(${JSON.stringify(resources)},()=>{${escapeScript(js)}},"slides");</script></body></html>`;
}

export const designLoaderHtml = () => {
  const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src blob: data:; worker-src blob:; media-src blob: data:; frame-src blob: data:; base-uri https://design.invalid; form-action 'none'; object-src 'none'";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><script>if(parent!==window)location.replace(${JSON.stringify(DESIGN_BOOTSTRAP_URL)}+"#"+crypto.randomUUID());<\/script>`;
};

export function designAssets(): Plugin {
  let slidesHtml: string | undefined;
  const buildSlides = () => (slidesHtml ??= buildDesignSandbox("slides"));
  return {
    name: "tarobot-design-sandbox",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === "/design-loader.html") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(designLoaderHtml()); return; }
        if (req.url === "/slides-sandbox.html") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(buildSlides()); return; }
        next();
      });
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "design-loader.html", source: designLoaderHtml() });
      this.emitFile({ type: "asset", fileName: "slides-sandbox.html", source: buildSlides() });
      for (const name of ["LICENSE", "NOTICE.md", "UPSTREAM.json", "editor/third-party-licenses.txt"]) {
        this.emitFile({ type: "asset", fileName: `licenses/baoyu-slides/${name.replace("editor/", "")}`, source: readFileSync(new URL(`./vendor/baoyu-slides/${name}`, import.meta.url), "utf8") });
      }
    },
  };
}
