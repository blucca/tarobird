import { sharedRoutesSchema, networkCanonical, type NetworkView } from "../../src/client-protocol/private-network.js";
import { routeUrlSchema, type Route } from "../../src/client-protocol/routes.js";
import { t } from "./i18n.js";

/** This edits the host's advertised VPS routes, preserving Direct, Tailscale and Cloudflare routes. */
export function localRelayRoutes(existing: Route[], relays: Route[]): Route[] {
  const normalized = relays.map(route => {
    const parsed = routeUrlSchema.safeParse(route.url.trim());
    if (!parsed.success) throw new Error(t("请输入有效 Hub HTTPS 地址"));
    return { ...route, name: "VPS" as const, url: parsed.data, label: route.label?.trim() || undefined };
  });
  const parsed = sharedRoutesSchema.safeParse([...existing.filter(route => route.name !== "VPS"), ...normalized]);
  if (!parsed.success) throw new Error(t("请填写不重复的 HTTPS 中转地址，最多 8 条；不能使用本机回环地址。"));
  return parsed.data;
}

/** This edits the host's advertised Cloudflare DIY Tunnel routes, preserving Direct, Tailscale and VPS routes. */
export function localCloudflareRoutes(existing: Route[], cloudflareOrigins: string[]): Route[] {
  const normalized: Route[] = cloudflareOrigins.map(url => {
    const parsed = routeUrlSchema.safeParse(url.trim());
    if (!parsed.success) throw new Error(t("请输入有效的 Cloudflare Tunnel HTTPS 地址"));
    return { name: "Cloudflare" as const, url: parsed.data };
  });
  const parsed = sharedRoutesSchema.safeParse([...existing.filter(route => route.name !== "Cloudflare"), ...normalized]);
  if (!parsed.success) throw new Error(t("请填写不重复的 HTTPS Cloudflare Tunnel 地址；所有中转合计最多 8 条，且不能使用本机回环地址。"));
  return parsed.data;
}

/** A LAN refresh can proceed independently; another relay edit must be reviewed. */
export function sameRelayConfiguration(previous: NetworkView, current: NetworkView): boolean {
  return previous.host.publicKey === current.host.publicKey
    && (previous.membership?.manifest.id ?? "") === (current.membership?.manifest.id ?? "")
    && (previous.membership?.manifest.authorityKey ?? "") === (current.membership?.manifest.authorityKey ?? "")
    && networkCanonical(previous.host.routes.filter(route => route.name === "VPS")) === networkCanonical(current.host.routes.filter(route => route.name === "VPS"));
}
