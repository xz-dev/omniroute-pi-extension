# OmniRoute Pi Extension Features

This document records the runtime features and invariants implemented by the OmniRoute Pi extension.

## Provider registration

- Registers a Pi model provider named `omniroute` with display name `OmniRoute`.
- Uses Pi's built-in `openai-completions` provider API implementation.
- Sends requests to `OMNIROUTE_BASE_URL` and uses the literal Pi config reference `$OMNIROUTE_API_KEY` for request authentication.
- Registers the provider in every non-metadata Pi startup path where models can be used:
  - interactive TUI sessions;
  - `pi --list-models`;
  - print/headless invocations, including piped stdin/stdout;
  - JSON/RPC modes;
  - SDK/subprocess-style runs such as subagent workers.
- Skips provider bootstrap for metadata-only commands that do not need models, currently `--help`, `-h`, `--version`, and `-v`.

## Configuration

| Environment variable | Purpose |
| --- | --- |
| `OMNIROUTE_BASE_URL` | Required base URL for OmniRoute, normalized by trimming trailing slashes. |
| `OMNIROUTE_API_KEY` | Required for live model discovery and request authentication; cached startup can still register cached models without it. |
| `OMNIROUTE_MODEL_CACHE_PATH` | Optional explicit model catalog cache path. |
| `OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS` | Optional positive timeout for live discovery; defaults to 15 seconds. |
| `PI_CODING_AGENT_DIR` | Used to derive the default cache location when `OMNIROUTE_MODEL_CACHE_PATH` is unset. |
| `PI_OFFLINE` | When truthy (`1`, `true`, `yes`), disables live discovery/refresh and uses only an existing valid cache. |

The default cache path is:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/omniroute/models-<first 16 hex chars of sha256(baseUrl)>.json
```

## Model Catalog Cache

The Model Catalog Cache is a local JSON snapshot of normalized OmniRoute models.
When a valid cache exists, it lets Pi Coding Agent interactive startup keep using OmniRoute models instead of quietly falling back to another logged-in provider/model when discovery is slow or unavailable; that fallback can be hidden from users and may lead to unexpected extra cost.

Cache entries include:

- `schemaVersion`;
- `provider`;
- normalized `baseUrl`;
- `fetchedAt` timestamp;
- normalized provider `models`.

Cache behavior:

- Cache files are validated before use.
- Invalid, mismatched, malformed, or empty cache files are ignored.
- Cache writes are atomic: write to a temporary file, then rename into place.
- Cache directories are created with mode `0700`; cache files are written with mode `0600`.
- Secrets are not persisted in cache files. The cache stores model metadata only, not `OMNIROUTE_API_KEY`, request headers, or bearer tokens.

## Startup and refresh behavior

All non-metadata startup paths follow the same provider availability invariant: register OmniRoute from cache if possible; otherwise perform live discovery unless offline or missing discovery credentials.

### Cache hit

- Registers cached models immediately so the `omniroute` provider is available during startup.
- Interactive TUI sessions and `pi --list-models` schedule a best-effort background Discovery Refresh after registering cached models.
- Headless/cache-hit paths such as print, JSON/RPC, piped stdio, and subagent workers use cached models without background refresh to keep non-interactive startup predictable.

### Cache miss or invalid cache

- If not offline and discovery credentials are present, startup performs blocking live discovery and registers the discovered provider before continuing.
- Successful discovery writes a normalized cache for future startups.
- If offline or discovery credentials are missing, no provider is registered unless a valid cache exists.

### Session refresh

- TUI `session_start` events schedule a best-effort Discovery Refresh.
- Non-TUI `session_start` events do not trigger extra refresh work.
- Refreshes are coalesced with an in-flight refresh promise so repeated triggers do not duplicate concurrent discovery requests.
- A live discovery result replaces the cache/provider only when it contains at least one usable text model.
- Discovery or provider-update failures are logged as warnings and keep the existing cached provider when available.

## Live discovery

Live discovery uses the OpenAI-compatible `${OMNIROUTE_BASE_URL}/models?prefix=alias` endpoint as the primary model catalog, asking OmniRoute to emit the short provider alias prefix (e.g. `cx/...`, `ollamacloud/...`) instead of the full canonical provider ID. The `/v1/models` shape does not standardize Pi thinking-level / reasoning-effort metadata, so the extension first infers efforts from a strict model ID suffix whitelist and then probes a supplemental OmniRoute metadata endpoint.

The currently available supplemental endpoint is the VS Code-compatible route:

```text
<base path without trailing /api or /v1>/api/v1/vscode/_/models
```

The extension uses this endpoint only because it can expose reasoning-effort metadata; it does not depend on VS Code itself. The supplemental endpoint is optional:

- `404` is ignored.
- Other failures are warned about, but primary discovery continues with suffix-based thinking-level inference.
- Reasoning-effort metadata is read from `supportsReasoningEffort`, `supports_reasoning_effort`, `supportedReasoningEfforts`, `configSchema.properties.reasoningEffort.enum`, or `configurationSchema.properties.reasoningEffort.enum`; matching uses strict model keys (`id`, `parent`, `owned_by/root`) first, then a root fallback only when that root appears once in the supplemental metadata.

## Model normalization

The extension converts raw OmniRoute models into Pi provider models.

Normalization rules:

- Uses the short provider alias prefix (e.g. `cx/gpt-5.5`, `ollamacloud/deepseek-v4-pro`) instead of the full canonical provider-id prefix (e.g. `codex/gpt-5.5`, `ollama-cloud/deepseek-v4-pro`), because the UI shows the short alias. Live discovery relies on OmniRoute's `?prefix=alias` catalog mode to emit alias-prefixed model ids.
- Excludes image-output-only models and models whose output modalities do not include text.
- Deduplicates raw entries by model `id`.
- For duplicate IDs, prefers the variant with image input support, then the larger context window, then the larger max output token count.
- Sorts models by ID for deterministic output.
- Recognizes only the suffixes `-none`, `-low`, `-medium`, `-high`, `-xhigh`, and `-max` as reasoning variants.
- Folds a suffix variant only when its exact suffix-stripped base is present as an eligible text model in the same primary catalog response.
- Keeps unknown suffixes and whitelisted suffix IDs without an eligible text base independently routable; an image-output model with the same bare ID is not treated as the base, and no bare model ID is synthesized.
- Infers reasoning efforts from verified suffix variants first, then merges supplemental reasoning-effort metadata when available.
- Represents Pi `off` as `null`, so no reasoning effort is sent; maps Pi `minimal` to provider effort `low`; and preserves `xhigh` and `max` as independent levels.
- Marks a model as reasoning-capable when raw capabilities include `reasoning`/`thinking` or when reasoning efforts are discovered.
- Maps unsupported thinking levels to `null` in `thinkingLevelMap` so Pi can hide or clamp them.
- For `deepseek-thinking` family models, maps Pi `xhigh` to provider value `max`.
- Sets input modalities to `['text']` or `['text', 'image']`.
- Uses zero-cost metadata because OmniRoute pricing is not represented by this extension.
- Defaults context and max-output token values when OmniRoute does not provide them.

## Provider compatibility

DeepSeek thinking-family models receive OpenAI-compatible provider compatibility settings:

```ts
{
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
}
```

Other models use the default Pi `openai-completions` compatibility unless OmniRoute metadata requires no special handling.

## Validation coverage

The test suite covers:

- cache-first startup for TUI and `--list-models`;
- provider bootstrap in headless modes including print, JSON/RPC, and non-TTY stdio;
- blocking discovery on cache miss for interactive and headless paths;
- offline mode behavior;
- invalid/mismatched cache rejection;
- cache write failures;
- refresh coalescing;
- TUI-only `session_start` refresh;
- preserving cached provider/cache when live discovery fails or returns no usable live catalog;
- real fixture model normalization;
- successful supplemental reasoning-effort metadata merging;
- provider config shape assertions (`name`, `api`, and literal `apiKey` reference);
- secret non-leakage into cache/fixtures;
- base URL normalization;
- default cache path derivation under `PI_CODING_AGENT_DIR`.

Run validation with:

```bash
npm run check
```
