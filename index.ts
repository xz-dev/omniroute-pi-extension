import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER = "omniroute";
const PROVIDER_DISPLAY_NAME = "Omniroute";
const BASE_URL = process.env.OMNIROUTE_BASE_URL?.trim();
const API_KEY_REFERENCE = "$OMNIROUTE_API_KEY";
const AUTH_HEADER_PREFIX = "Bearer ";
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_ERROR_BODY_LENGTH = 500;

interface OmnirouteModel {
  id: string;
  name?: string;
  root?: string;
  parent?: string | null;
  owned_by?: string;
  type?: string;
  family?: string | null;
  capabilities?: {
    reasoning?: boolean;
    thinking?: boolean;
    vision?: boolean;
  };
  input_modalities?: string[];
  output_modalities?: string[];
  context_length?: number;
  max_output_tokens?: number;
  max_input_tokens?: number;
}

interface ReasoningConfigSchema {
  properties?: {
    reasoningEffort?: {
      enum?: unknown;
    };
  };
}

interface VscodeModel {
  id?: string;
  root?: string;
  owned_by?: string;
  parent?: string | null;
  supportedReasoningEfforts?: unknown;
  supportsReasoningEffort?: unknown;
  supports_reasoning_effort?: unknown;
  configSchema?: ReasoningConfigSchema;
  configurationSchema?: ReasoningConfigSchema;
}

interface DataPayload<T> {
  data?: T[];
}

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";
type ReasoningEffort = ThinkingLevel;


const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);
const DEEPSEEK_THINKING_FAMILY = "deepseek-thinking";
const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function isTextModel(model: OmnirouteModel): boolean {
  if (model.type === "image") return false;
  if (!model.output_modalities || model.output_modalities.length === 0) return true;
  return model.output_modalities.includes("text");
}

function betterModel(a: OmnirouteModel, b: OmnirouteModel): OmnirouteModel {
  const aImage = a.input_modalities?.includes("image") ?? false;
  const bImage = b.input_modalities?.includes("image") ?? false;
  if (!aImage && bImage) return b;

  if (aImage === bImage) {
    const aContext = a.context_length ?? a.max_input_tokens ?? 0;
    const bContext = b.context_length ?? b.max_input_tokens ?? 0;
    if (bContext > aContext) return b;

    const aTokens = a.max_output_tokens ?? 0;
    const bTokens = b.max_output_tokens ?? 0;
    if (bTokens > aTokens) return b;
  }

  return a;
}

function normalizeThinkingLevels(levels: ThinkingLevel[], options?: { xhighValue?: string }) {
  const has = new Set(levels);
  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, has.has(level) ? (level === "xhigh" ? (options?.xhighValue ?? level) : level) : null]),
  ) as Record<ThinkingLevel, string | null>;
}

function mergeThinkingLevels(baseLevels: ThinkingLevel[], extraLevels: ReasoningEffort[]) {
  return [...new Set([...baseLevels, ...extraLevels])];
}

function isThinkingVariant(id: string): { base: string; level?: ThinkingLevel } {
  const dash = id.lastIndexOf("-");
  if (dash < 0) return { base: id };

  const suffix = id.slice(dash + 1);
  if (!THINKING_LEVEL_SET.has(suffix)) return { base: id };

  return { base: id.slice(0, dash), level: suffix as ThinkingLevel };
}

function parseReasoningEfforts(values: unknown): ReasoningEffort[] {
  if (!Array.isArray(values)) return [];

  const efforts: ReasoningEffort[] = [];

  for (const value of values) {
    if (typeof value !== "string") continue;

    const normalized = value.trim().toLowerCase().replace(/[_\s-]+/g, "");
    if (normalized === "off" || normalized === "none") continue;

    const effort = normalized === "max" ? "xhigh" : (normalized as ReasoningEffort);
    if (!THINKING_LEVEL_SET.has(effort)) continue;

    if (!efforts.includes(effort)) {
      efforts.push(effort);
    }
  }

  return efforts;
}

function getEffortsFromVscodeModel(model: VscodeModel): ReasoningEffort[] {
  for (const candidate of [
    model.supportsReasoningEffort,
    model.supports_reasoning_effort,
    model.supportedReasoningEfforts,
    model.configSchema?.properties?.reasoningEffort?.enum,
    model.configurationSchema?.properties?.reasoningEffort?.enum,
  ]) {
    const efforts = parseReasoningEfforts(candidate);
    if (efforts.length > 0) return efforts;
  }

  return [];
}

function normalizeModelToken(value?: string | null) {
  return value?.trim().toLowerCase();
}

function addModelKey(keys: Set<string>, value?: string | null) {
  const key = normalizeModelToken(value);
  if (key) keys.add(key);
}

function strictModelKeys(model: { id?: string; root?: string; parent?: string | null; owned_by?: string }) {
  const keys = new Set<string>();
  addModelKey(keys, model.id);
  addModelKey(keys, model.parent);
  if (model.owned_by && model.root) addModelKey(keys, `${model.owned_by}/${model.root}`);
  return [...keys];
}

function rootModelKey(model: { root?: string }) {
  return normalizeModelToken(model.root);
}

function mergeEffortIntoIndex(index: Map<string, ReasoningEffort[]>, key: string | undefined, efforts: ReasoningEffort[]) {
  if (!key) return;
  index.set(key, mergeThinkingLevels(index.get(key) ?? [], efforts));
}

function buildVscodeEffortIndex(vscodeModels: VscodeModel[]) {
  const strict = new Map<string, ReasoningEffort[]>();
  const rootCandidates = new Map<string, { count: number; efforts: ReasoningEffort[] }>();

  for (const model of vscodeModels) {
    const efforts = getEffortsFromVscodeModel(model);
    if (efforts.length === 0) continue;

    for (const key of strictModelKeys(model)) {
      mergeEffortIntoIndex(strict, key, efforts);
    }

    const rootKey = rootModelKey(model);
    if (rootKey) {
      const current = rootCandidates.get(rootKey) ?? { count: 0, efforts: [] };
      rootCandidates.set(rootKey, {
        count: current.count + 1,
        efforts: mergeThinkingLevels(current.efforts, efforts),
      });
    }
  }

  const root = new Map<string, ReasoningEffort[]>();
  for (const [key, candidate] of rootCandidates) {
    if (candidate.count === 1) root.set(key, candidate.efforts);
  }

  return { strict, root };
}

type VscodeEffortIndex = ReturnType<typeof buildVscodeEffortIndex>;

function getVscodeEffortsForModel(model: OmnirouteModel, effortIndex: VscodeEffortIndex) {
  let efforts: ReasoningEffort[] = [];
  for (const key of strictModelKeys(model)) {
    efforts = mergeThinkingLevels(efforts, effortIndex.strict.get(key) ?? []);
  }
  if (efforts.length > 0) return efforts;

  return effortIndex.root.get(rootModelKey(model) ?? "") ?? [];
}

function toProviderModel(model: OmnirouteModel, levels: ThinkingLevel[]) {
  const reasoning = Boolean(model.capabilities?.reasoning || model.capabilities?.thinking || levels.length > 0);
  const isDeepseekFamily = model.family === DEEPSEEK_THINKING_FAMILY;
  const thinkingLevelMap = normalizeThinkingLevels(levels, { xhighValue: isDeepseekFamily ? "max" : undefined });

  return {
    id: model.id,
    name: model.root ?? model.name ?? model.id,
    reasoning,
    ...(reasoning ? { thinkingLevelMap } : {}),
    ...(reasoning && isDeepseekFamily ? { compat: DEEPSEEK_COMPAT } : {}),
    input: (model.input_modalities?.includes("image") ? ["text", "image"] : ["text"]) as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_length ?? model.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };
}

function normalizeModels(rawModels: OmnirouteModel[], effortIndex: VscodeEffortIndex) {
  const deduped = new Map<string, OmnirouteModel>();
  for (const model of rawModels.filter((candidate) => candidate?.id && isTextModel(candidate))) {
    const current = deduped.get(model.id);
    deduped.set(model.id, current ? betterModel(current, model) : model);
  }

  const models = [...deduped.entries()].sort(([a], [b]) => a.localeCompare(b));
  const used = new Set<string>();
  const normalized: ReturnType<typeof toProviderModel>[] = [];

  for (const [id, model] of models) {
    if (used.has(id)) continue;

    const { base, level } = isThinkingVariant(id);
    const matchedLevels: ThinkingLevel[] = [];

    if (!level) {
      for (const [variantId] of models) {
        if (used.has(variantId)) continue;
        const parsed = isThinkingVariant(variantId);
        if (parsed.base === id && parsed.level) {
          used.add(variantId);
          matchedLevels.push(parsed.level);
        }
      }

      const levels = mergeThinkingLevels(matchedLevels, getVscodeEffortsForModel(model, effortIndex));

      used.add(id);
      normalized.push(toProviderModel(model, levels));
      continue;
    }

    if (!used.has(base)) {
      const levels = mergeThinkingLevels([level], getVscodeEffortsForModel(model, effortIndex));
      used.add(id);
      normalized.push(toProviderModel(model, levels));
    }
  }

  return normalized;
}

function deriveVscodeModelsUrl(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");

  try {
    const url = new URL(trimmed);
    const pathParts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (pathParts[pathParts.length - 1] === "v1") pathParts.pop();
    if (pathParts[pathParts.length - 1] === "api") pathParts.pop();

    url.pathname = `/${[...pathParts, "api", "v1", "vscode", "_", "models"].join("/")}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return `${trimmed.replace(/(?:\/api)?\/v1$/, "")}/api/v1/vscode/_/models`;
  }
}

function cleanConfigValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function getDiscoveryApiKey() {
  return cleanConfigValue(process.env.OMNIROUTE_API_KEY);
}

function getBaseUrl() {
  return cleanConfigValue(BASE_URL);
}

async function responseErrorSummary(response: Response) {
  const body = (await response.text()).trim();
  if (!body) return `Model discovery failed: ${response.status}`;

  const summary = body.length > MAX_ERROR_BODY_LENGTH ? `${body.slice(0, MAX_ERROR_BODY_LENGTH)}…` : body;
  return `Model discovery failed: ${response.status} ${summary}`;
}

async function discoverModels() {
  const apiKey = getDiscoveryApiKey();
  const baseUrl = getBaseUrl();
  if (!apiKey || !baseUrl) {
    return [];
  }

  const headers = { Authorization: `${AUTH_HEADER_PREFIX}${apiKey}` };
  const timeoutSignal = new AbortController();
  const timeout = setTimeout(() => timeoutSignal.abort(), MODEL_DISCOVERY_TIMEOUT_MS);

  try {
    const mainResponse = await fetch(`${baseUrl}/models`, {
      headers,
      signal: timeoutSignal.signal,
    });

    if (!mainResponse.ok) {
      throw new Error(await responseErrorSummary(mainResponse));
    }

    const payload = (await mainResponse.json()) as DataPayload<OmnirouteModel>;

    const vscodeModelsUrl = deriveVscodeModelsUrl(baseUrl);
    let vscodeEffortsIndex = buildVscodeEffortIndex([]);

    try {
      const vscodeResponse = await fetch(vscodeModelsUrl, {
        headers,
        signal: timeoutSignal.signal,
      });

      if (vscodeResponse.ok) {
        const vscodePayload = (await vscodeResponse.json()) as DataPayload<VscodeModel>;
        vscodeEffortsIndex = buildVscodeEffortIndex(vscodePayload.data ?? []);
      } else if (vscodeResponse.status !== 404) {
        console.warn(
          `[${PROVIDER}] VSCode model effort discovery failed (${vscodeResponse.status}); continuing with suffix inference only.`,
        );
      }
    } catch (vscodeError) {
      console.warn(
        `[${PROVIDER}] VSCode model effort discovery failed; continuing with suffix inference only.`,
        vscodeError instanceof Error ? vscodeError.message : vscodeError,
      );
    }

    const models = normalizeModels(payload.data ?? [], vscodeEffortsIndex);
    if (models.length > 0) return models;

    throw new Error("Model discovery returned no usable text models");
  } catch (error) {
    console.warn(
      `[${PROVIDER}] Model discovery failed; skipping provider registration.`,
      error instanceof Error ? error.message : error,
    );
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export default async function (pi: ExtensionAPI) {
  const models = await discoverModels();
  if (models.length === 0) {
    return;
  }

  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    return;
  }

  pi.registerProvider(PROVIDER, {
    name: PROVIDER_DISPLAY_NAME,
    baseUrl,
    apiKey: API_KEY_REFERENCE,
    api: "openai-completions",
    models,
  });
}
