import { EFFORT_LEVELS, type EffortLevel } from "../state/config-file-schema.js";

export type DeepSeekModelChoice = { id: string; label: string; provider: string; modelId: string; efforts: ("" | EffortLevel)[] };
export type DeepSeekModelCatalog = { status: "ready" | "no-models" | "unavailable"; models: DeepSeekModelChoice[]; defaultModel?: string; defaultEffort?: string };
const PREFIX = "dsh-model:";
const identity = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\p{Cc}\uD800-\uDFFF]/u.test(value);
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Ordinary provider/model paths retain their legacy spelling. Exceptional
 * opaque IDs use a namespace, so '/' in a provider never changes its identity. */
export function encodeDeepSeekModel(provider: string, modelId: string): string {
  if (!identity(provider) || !identity(modelId)) throw new Error("model_id_invalid");
  return !provider.includes("/") && !/[\s%]/u.test(provider + modelId) && !provider.startsWith(PREFIX)
    ? `${provider}/${modelId}` : `${PREFIX}${encodeURIComponent(provider)}/${encodeURIComponent(modelId)}`;
}
export function decodeDeepSeekModel(value: string): { provider: string; modelId: string } | undefined {
  if (!value || value.length > 512 || /[\s\p{Cc}]/u.test(value)) return;
  const encoded = value.startsWith(PREFIX), body = encoded ? value.slice(PREFIX.length) : value;
  const separator = body.indexOf("/");
  if (separator <= 0 || separator === body.length - 1) return;
  try {
    const provider = encoded ? decodeURIComponent(body.slice(0, separator)) : body.slice(0, separator);
    const modelId = encoded ? decodeURIComponent(body.slice(separator + 1)) : body.slice(separator + 1);
    if (!identity(provider) || !identity(modelId)) return;
    if (encoded && encodeDeepSeekModel(provider, modelId) !== value) return;
    return { provider, modelId };
  } catch { return; }
}

/** Public session/modelCatalog projection. Raw failures, credentials, API
 * parameter maps and arbitrary plugin fields never leave this boundary. */
export function parseDeepSeekModelCatalog(value: unknown): DeepSeekModelCatalog {
  const raw = record(value), models: DeepSeekModelChoice[] = [], seen = new Set<string>();
  const unavailable = (): DeepSeekModelCatalog => ({ status: "unavailable", models });
  if (!raw || !Array.isArray(raw.groups) || !Array.isArray(raw.failures) || !Array.isArray(raw.routableProviders)
    || raw.groups.length > 256 || raw.failures.length > 256) return unavailable();
  let malformed = false;
  for (const entry of raw.groups) {
    const group = record(entry);
    if (!identity(group?.id) || !Array.isArray(group.models) || !raw.routableProviders.includes(group.id) || group.models.length > 4096) { malformed = true; continue; }
    for (const entry of group.models) {
      const model = record(entry);
      if (!identity(model?.id)) { malformed = true; continue; }
      let id: string; try { id = encodeDeepSeekModel(group.id, model.id); } catch { malformed = true; continue; }
      if (id.length > 512 || seen.has(id) || models.length >= 4096) { malformed = true; continue; }
      const reasoning = record(model.reasoning);
      if (model.reasoning !== undefined && (!reasoning || !Array.isArray(reasoning.efforts))) { malformed = true; continue; }
      const levels = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts.map(item => record(item)?.id) : [];
      const efforts: ("" | EffortLevel)[] = ["", ...EFFORT_LEVELS.filter(level => levels.includes(level))];
      const name = typeof model.name === "string" && model.name.trim() && !/\p{Cc}/u.test(model.name) ? model.name.trim().slice(0, 160) : model.id;
      seen.add(id); models.push({ id, provider: group.id, modelId: model.id, label: name, efforts });
    }
  }
  const selected = record(raw.default);
  let defaultModel: string | undefined;
  if (identity(selected?.provider) && identity(selected.model)) {
    try { defaultModel = encodeDeepSeekModel(selected.provider, selected.model); } catch { /* invalid default */ }
  }
  return { status: malformed || raw.failures.length ? "unavailable" : models.length ? "ready" : "no-models", models,
    ...(defaultModel ? { defaultModel } : {}), ...(typeof selected?.reasoningEffort === "string" ? { defaultEffort: selected.reasoningEffort } : {}) };
}

/** Resolve a legacy bare ID only when the current catalog is unambiguous. */
export function findDeepSeekModel<T extends { id: string; provider?: string; modelId?: string }>(choices: readonly T[], value: string): T | undefined {
  const exact = choices.find(choice => choice.id === value);
  if (exact) return exact;
  const decoded = decodeDeepSeekModel(value);
  const matches = decoded
    ? choices.filter(choice => choice.id && choice.provider === decoded.provider && choice.modelId === decoded.modelId)
    : value.startsWith(PREFIX) ? [] : choices.filter(choice => choice.id && choice.modelId === value);
  return matches.length === 1 ? matches[0] : undefined;
}
