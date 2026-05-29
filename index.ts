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
  type?: string;
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

type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

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

function thinkingLevelMap(levels: Iterable<ThinkingLevel>) {
  const has = new Set(levels);
  return Object.fromEntries(THINKING_LEVELS.map((level) => [level, has.has(level) ? level : null])) as Record<ThinkingLevel, string | null>;
}

function isThinkingVariant(id: string): { base: string; level?: ThinkingLevel } {
  const dash = id.lastIndexOf("-");
  if (dash < 0) return { base: id };

  const suffix = id.slice(dash + 1);
  if (!THINKING_LEVEL_SET.has(suffix)) return { base: id };

  return { base: id.slice(0, dash), level: suffix as ThinkingLevel };
}

function toProviderModel(model: OmnirouteModel, levels: ThinkingLevel[]) {
  const reasoning = Boolean(model.capabilities?.reasoning || model.capabilities?.thinking);

  return {
    id: model.id,
    name: model.root ?? model.name ?? model.id,
    reasoning,
    ...(reasoning ? { thinkingLevelMap: thinkingLevelMap(levels) } : {}),
    input: (model.input_modalities?.includes("image") ? ["text", "image"] : ["text"]) as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_length ?? model.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_output_tokens ?? DEFAULT_MAX_TOKENS,
  };
}

function normalizeModels(rawModels: OmnirouteModel[]) {
  const deduped = new Map<string, OmnirouteModel>();
  for (const model of rawModels.filter((m) => m?.id && isTextModel(m))) {
    const current = deduped.get(model.id);
    deduped.set(model.id, current ? betterModel(current, model) : model);
  }

  const models = [...deduped.entries()].sort(([a], [b]) => a.localeCompare(b));
  const used = new Set<string>();
  const normalized: ReturnType<typeof toProviderModel>[] = [];

  // Merge explicit thinking variants into base models.
  for (const [id, model] of models) {
    if (used.has(id)) continue;

    const { base, level } = isThinkingVariant(id);
    const matchedLevels: ThinkingLevel[] = [];

    if (!level) {
      for (const [variantId, variant] of models) {
        if (used.has(variantId)) continue;
        const parsed = isThinkingVariant(variantId);
        if (parsed.base === id && parsed.level) {
          used.add(variantId);
          matchedLevels.push(parsed.level);
        }
      }

      used.add(id);
      normalized.push(toProviderModel(model, matchedLevels));
      continue;
    }

    // If a variant appears without its base model, register it as-is.
    if (!used.has(base)) {
      used.add(id);
      normalized.push(toProviderModel(model, level ? [level] : []));
    }
  }

  return normalized;
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_DISCOVERY_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `${AUTH_HEADER_PREFIX}${apiKey}` },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await responseErrorSummary(response));
    }

    const payload = (await response.json()) as { data?: OmnirouteModel[] };
    const models = normalizeModels(payload.data ?? []);
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
