# OmniRoute Pi Extension

A Pi extension that registers the `omniroute` model provider from an OmniRoute-compatible gateway.

## What it does

- Reads `OMNIROUTE_BASE_URL` and `OMNIROUTE_API_KEY`.
- Registers cached models immediately when a valid model catalog cache exists.
- Falls back to live discovery when needed.
- Writes the normalized model catalog cache under `PI_CODING_AGENT_DIR` unless `OMNIROUTE_MODEL_CACHE_PATH` is set.

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
${PI_CODING_AGENT_DIR:-~/.pi/agent}/omniroute/models-<sha256(baseUrl)[0..16]>.json
```

## Commands

- `npm test` — run the test suite.
- `npm run check` — run syntax checks and tests.
- `npm run check:syntax` — run the Node syntax check used by the test flow.

## Repository layout

- `index.ts` — extension entry point.
- `tests/omniroute-cache.test.ts` — model catalog cache tests.
- `docs/features.md` — runtime behavior notes.
- `docs/adr/0001-cache-model-catalog-for-interactive-startup.md` — design record for cache-first startup.
