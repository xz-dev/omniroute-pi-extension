# Use supplemental model metadata for reasoning effort

The primary OmniRoute `/models?prefix=alias` endpoint remains the source of truth for the Model Catalog. Alias prefix mode keeps the short provider IDs shown in the UI while determining which models exist and providing the base metadata that Pi needs to register the `omniroute` provider.

The OpenAI-compatible `/v1/models` shape does not standardize Pi thinking-level / reasoning-effort metadata. Therefore discovery first infers efforts from the explicit model ID suffix whitelist `-none`, `-low`, `-medium`, `-high`, `-xhigh`, and `-max`. `none` maps to Pi's `off`, while `max` remains a distinct level above `xhigh`. After suffix inference, the extension probes a supplemental OmniRoute endpoint that may expose richer reasoning-effort metadata.

The currently available supplemental endpoint is the VS Code-compatible `/api/v1/vscode/_/models` route derived from the configured base URL. We use it because it can expose reasoning-effort fields; we are not depending on VS Code itself. A successful response can add or refine `thinkingLevelMap` entries for models that already came from the primary catalog.

A suffix variant is folded only when its exact suffix-stripped base is present as an eligible text model in the same primary catalog response. A response may omit that base or use the same ID for an image-output model; in either case the text suffix model remains independently routable rather than making the extension invent or misuse a base ID. Unknown future suffixes also remain untouched.

This supplemental endpoint is optional. `404` and other failures never block model discovery, cache writes, or provider registration; discovery keeps the suffix-inferred thinking levels when supplemental metadata is unavailable. This keeps the model catalog resilient while still using richer reasoning-effort metadata when OmniRoute provides it.
