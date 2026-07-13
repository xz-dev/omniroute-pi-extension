# Codex ultra alias filter design

## Goal

Hide OmniRoute's synthetic `gpt-5.6-sol-ultra` and `gpt-5.6-terra-ultra` Codex aliases from Pi without changing OmniRoute's catalog or affecting other clients. Keep the real Sol and Terra base models available with Pi's independent `max` thinking level.

## Scope

The filter belongs only to the OmniRoute Pi extension's catalog ingestion paths: live model normalization and cached model loading. A live model is hidden only when both conditions hold:

- `owned_by` identifies Codex;
- its normalized `root`, or the final segment of its ID when `root` is absent, is exactly `gpt-5.6-sol-ultra` or `gpt-5.6-terra-ultra`.

Normalized cache entries do not retain `owned_by` or `root`, so cached models use an exact `cx/` or `codex/` ID prefix plus the same exact final ID segment. This keeps old offline and headless caches from bypassing the filter. The provider check prevents an unrelated provider from losing a model that happens to use the same root, while the exact-root allowlist prevents the filter from becoming a generic rule for future `-ultra` IDs.

## Behavior

The two aliases are omitted rather than folded into the base model. Pi has no `ultra` thinking level, and the current OmniRoute transport reduces these aliases to the base model with effort `max`; exposing them would therefore imply behavior beyond what Pi receives.

All ordinary reasoning suffix folding remains unchanged. In particular, verified `-max` variants continue contributing the `max` effort to their exact text base. Other unknown suffixes, including other Codex `-ultra` IDs, remain independently routable.

## Tests

Regression coverage uses the normalized provider catalog as the public behavior boundary. It verifies that:

- the Codex Sol and Terra synthetic ultra aliases are absent;
- the Terra base remains present with `max` support;
- a different Codex ultra ID remains present;
- another provider's model with the same Sol ultra root remains present;
- an existing offline cache receives the same narrow filtering while unrelated cached IDs remain present.

## Non-goals

This change does not modify OmniRoute, its persisted model catalog, upstream PRs, request transport, or Pi's thinking-level type. It does not attempt to implement Codex Ultra's task-delegation behavior.
