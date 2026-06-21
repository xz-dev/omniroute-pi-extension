# Use supplemental model metadata for reasoning effort

The primary OmniRoute `/models` endpoint remains the source of truth for the Model Catalog. It determines which models exist and provides the base metadata that Pi needs to register the `omniroute` provider.

The OpenAI-compatible `/v1/models` shape does not standardize Pi thinking-level / reasoning-effort metadata. Therefore discovery first infers thinking levels from model ID suffixes such as `-low`, `-high`, and `-xhigh`. After suffix inference, the extension probes a supplemental OmniRoute endpoint that may expose richer reasoning-effort metadata.

The currently available supplemental endpoint is the VS Code-compatible `/api/v1/vscode/_/models` route derived from the configured base URL. We use it because it can expose reasoning-effort fields; we are not depending on VS Code itself. A successful response can add or refine `thinkingLevelMap` entries for models that already came from the primary catalog.

This supplemental endpoint is optional. `404` and other failures never block model discovery, cache writes, or provider registration; discovery keeps the suffix-inferred thinking levels when supplemental metadata is unavailable. This keeps the model catalog resilient while still using richer reasoning-effort metadata when OmniRoute provides it.
