# Cache OmniRoute model catalog for interactive startup

OmniRoute model discovery can be slow or unavailable at Pi startup, but built-in Pi providers avoid this by shipping a generated model catalog with the release. We decided that the OmniRoute provider must be registered wherever Pi can use models, including interactive TUI sessions, `pi --list-models`, print/headless invocations, JSON/RPC modes, SDK-style subprocesses, and subagent workers.

All non-metadata startup paths should first register OmniRoute from the last valid local Model Catalog Cache when one exists. If no valid cache exists and startup is not explicitly offline, startup falls back to blocking live discovery so the provider is still available like a built-in provider. Interactive TUI sessions and `pi --list-models` additionally run a best-effort Discovery Refresh in the background after a cache hit and replace the cache/provider only when the live result is valid. Headless cache-hit paths use the cache without background network refresh to keep non-interactive startup predictable.

This trades possibly stale model selection during startup for a fast and resilient experience while preserving the invariant that a cached OmniRoute provider is available in every model-using Pi mode.
