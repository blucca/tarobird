import { useEffect, useRef } from "react";
import {
  PLUGIN_HOST_PROTOCOL,
  pluginHostRequestSchema,
  requiredCapabilityForMethod,
  type PluginCapability,
  type PluginHostResponse,
} from "../../src/client-protocol/plugins.js";
import type { InstalledPluginRecord } from "./plugin-registry.js";
import { useLocale } from "./i18n.js";
import { writeClipboardText } from "./clipboard-write.js";

/** Pure sandbox host-API dispatcher so capability gating is directly unit-testable.
 * Never exposes App tokens, Hub credentials, or Hub HTTP/WebSocket APIs. */
export async function handlePluginHostMessage(
  raw: unknown,
  context: {
    pluginId: string;
    grantedCapabilities: readonly PluginCapability[];
    theme: "light" | "dark";
    locale: string;
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
    writeClipboard?: (text: string) => Promise<void>;
  },
): Promise<PluginHostResponse | null> {
  const parsed = pluginHostRequestSchema.safeParse(raw);
  if (!parsed.success) {
    if (raw && typeof raw === "object" && (raw as Record<string, unknown>).protocol === PLUGIN_HOST_PROTOCOL && typeof (raw as Record<string, unknown>).id === "string") {
      return { protocol: PLUGIN_HOST_PROTOCOL, id: String((raw as Record<string, unknown>).id), ok: false, error: "method_not_allowed" };
    }
    return null;
  }
  const req = parsed.data;
  const required = requiredCapabilityForMethod(req.method);
  if (required && !context.grantedCapabilities.includes(required)) {
    return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: false, error: "capability_denied" };
  }
  const prefix = `tarobird.plugin.data.${context.pluginId}.`;
  switch (req.method) {
    case "host.hello":
      return {
        protocol: PLUGIN_HOST_PROTOCOL,
        id: req.id,
        ok: true,
        result: {
          pluginId: context.pluginId,
          theme: context.theme,
          locale: context.locale,
          grantedCapabilities: [...context.grantedCapabilities],
        },
      };
    case "theme.get":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: { theme: context.theme } };
    case "storage.get":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: context.storage.getItem(prefix + req.key) };
    case "storage.set":
      context.storage.setItem(prefix + req.key, req.value);
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    case "storage.remove":
      context.storage.removeItem(prefix + req.key);
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    case "clipboard.write":
      await (context.writeClipboard ? context.writeClipboard(req.text) : writeClipboardText(req.text));
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: true };
    case "workbench.status":
      return { protocol: PLUGIN_HOST_PROTOCOL, id: req.id, ok: true, result: { isolated: true, sandbox: "opaque-origin" } };
  }
}

function wrapSandboxedDocument(bundleHtml: string, grantedDomains: readonly string[]): string {
  const connectSources = grantedDomains
    .map((domain) => domain.trim())
    .filter((domain) => /^[a-z0-9.-]+(?::\d+)?$/i.test(domain))
    .map((domain) => `https://${domain}`)
    .join(" ");
  const csp = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    `connect-src ${connectSources || "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  return /<head[^>]*>/i.test(bundleHtml)
    ? bundleHtml.replace(/<head[^>]*>/i, (match) => `${match}${cspTag}`)
    : `<!doctype html><html><head>${cspTag}</head><body>${bundleHtml}</body></html>`;
}

/** Isolated iframe runtime for an installed plugin. Loads `/plugin-sandbox.html`
 * inside `sandbox="allow-scripts"` WITHOUT `allow-same-origin` (unique opaque origin)
 * and injects a per-plugin CSP scoped strictly to `grantedDomains`, so the plugin
 * cannot access App tokens, cookies, IndexedDB, localStorage, or the Hub API. */
export function PluginSandboxFrame({ plugin, title }: { plugin: InstalledPluginRecord; title?: string }) {
  const locale = useLocale();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameTitle = title ?? (locale === "zh" ? plugin.manifest.nameZh ?? plugin.manifest.name : plugin.manifest.name);
  const wrappedDoc = wrapSandboxedDocument(plugin.bundleHtml, plugin.grantedDomains);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || event.source !== frameWindow) return;
      if (event.data && typeof event.data === "object" && (event.data as Record<string, unknown>).type === "tarobird-plugin-shell-ready") {
        frameWindow.postMessage({ type: "tarobird-plugin-init", title: frameTitle, document: wrappedDoc }, "*");
        return;
      }
      const dark = document.documentElement.dataset.theme === "dark"
        || document.documentElement.classList.contains("dark")
        || window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      void handlePluginHostMessage(event.data, {
        pluginId: plugin.manifest.id,
        grantedCapabilities: plugin.grantedCapabilities,
        theme: dark ? "dark" : "light",
        locale,
        storage: window.localStorage,
      }).then((response) => {
        if (response && iframeRef.current?.contentWindow === frameWindow) {
          frameWindow.postMessage(response, "*");
        }
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [plugin.manifest.id, plugin.grantedCapabilities, locale, frameTitle, wrappedDoc]);

  return (
    <iframe
      key={`${plugin.manifest.id}:${plugin.manifest.version}`}
      ref={iframeRef}
      className="plugin-sandbox-frame"
      title={frameTitle}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src="/plugin-sandbox.html"
    />
  );
}
