# OmniRoute Pi Extension

This context describes the provider-integration language used by the OmniRoute Pi extension.

## Language

**OmniRoute Provider**:
A Pi model provider backed by an OmniRoute-compatible model gateway.
_Avoid_: generic proxy, upstream provider

**Model Catalog**:
The set of OmniRoute models exposed to Pi for selection.
_Avoid_: model cache, provider list

**Model Catalog Cache**:
A local snapshot of the Model Catalog used to make interactive startup resilient when live discovery is slow or unavailable.
_Avoid_: prompt cache, response cache

**Discovery Refresh**:
A best-effort attempt to fetch the current Model Catalog from OmniRoute and replace the Model Catalog Cache when the result is valid.
_Avoid_: blocking discovery, forced reload

**Interactive Session Startup**:
Startup of a Pi TUI session. This path uses the Model Catalog Cache immediately, then refreshes in the background. `pi --list-models` follows the same cache-first bootstrap behavior.
_Avoid_: print startup, RPC startup
