# OmniRoute Pi Extension

A Pi extension that registers the `omniroute` model provider from an OmniRoute-compatible gateway.

## Installation

```bash
pi install git:github.com/xz-dev/omniroute-pi-extension
```

## What it does

- Reads `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY`.
- Registers every OmniRoute model through Pi's built-in `openai-responses` provider API. Pi renders readable reasoning summaries, while OmniRoute supplies a visible placeholder when Codex exposes only encrypted private reasoning.
- Registers cached models immediately when a valid Model Catalog Cache exists.
- Falls back to live discovery when needed.
- Writes the normalized Model Catalog Cache under `PI_CODING_AGENT_DIR` unless `OMNIROUTE_MODEL_CACHE_PATH` is set.
- When a valid Model Catalog Cache exists, keeps Pi Coding Agent interactive startup from silently falling back to another logged-in provider/model when OmniRoute live discovery is slow or unavailable, which can be hidden from users and may cause unexpected extra cost.

## Configuration

| Variable | Purpose |
| --- | --- |
| `OMNIROUTE_BASE_URL` | OmniRoute base URL, without a trailing slash. |
| `OMNIROUTE_API_KEY` | API key used for live discovery and requests. |
| `OMNIROUTE_MODEL_CACHE_PATH` | Optional explicit cache file path. |
| `OMNIROUTE_MODEL_DISCOVERY_TIMEOUT_MS` | Live discovery timeout in milliseconds. |
| `PI_CODING_AGENT_DIR` | Base directory for the default cache path. |
| `PI_OFFLINE` | When truthy, disables live discovery and refresh. |

Default cache path:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/omniroute/models-<first 16 hex chars of sha256(baseUrl)>.json
```

## Commands

- `npm test` — run the test suite, including the two-turn Responses consumer contract pinned to `@xz-dev/pi-ai@0.80.6-xz.41.1.g7944e190` through the `@earendil-works/pi-ai` development alias.
- `npm run check` — run syntax checks and tests.
- `npm run check:syntax` — run the Node syntax check used by the test flow.

## Repository layout

- `index.ts` — extension entry point.
- `tests/omniroute-cache.test.ts` — model catalog cache tests.
- `docs/features.md` — runtime behavior notes.
- `docs/adr/0001-discover-reasoning-effort-metadata.md` — design record for reasoning-effort discovery beyond `/v1/models`.
- `docs/adr/0002-cache-model-catalog-for-interactive-startup.md` — design record for cache-first startup.
