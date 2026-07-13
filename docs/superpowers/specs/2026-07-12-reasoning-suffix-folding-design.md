# Reasoning suffix folding design

## Goal

Keep OmniRoute's standard `/models` response as the source of truth for model IDs and model metadata. Continue using `/api/v1/vscode/_/models` only as supplemental reasoning-effort metadata. Fold known reasoning variants into a verified real base model without inventing model IDs or conflating distinct effort levels.

## Effort model

The API suffix whitelist is `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Pi exposes `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`. Represent Pi `off` as `null` so the wire effort is omitted, map Pi `minimal` to provider `low`, and preserve `max` as its own level above `xhigh`.

`ultra` and all other unknown suffixes are not interpreted. They remain ordinary model IDs.

## Verified folding

Primary discovery requests `/models?prefix=alias` so OmniRoute returns the short provider IDs used by the UI instead of the full canonical provider IDs. The catalog is dynamic and alias mode may return a reasoning suffix entry without an exact unsuffixed base.

A suffixed primary model folds only when its exact suffix-stripped base is present as an eligible text model in the same primary response. A same-ID image-output entry does not qualify as the base. Otherwise the suffix model remains independently routable, even if other metadata describes reasoning efforts. This preserves `/models` as the authority for routable IDs and prevents the extension from synthesizing or misusing a bare ID.

The selected base entry remains authoritative for display name, context limits, modalities, and other model metadata. Variant entries contribute only their reasoning effort.

## Supplemental metadata

The VS Code endpoint may add supported efforts to a primary model found through strict ID keys or an unambiguous root key. It never creates a provider model, replaces a primary ID, or supplies primary model metadata.

## Tests

Regression coverage verifies independent `xhigh` and `max`, `none` to `off`, exact-base folding within the alias catalog, retention of suffix models with no real base, retention of unknown future suffixes, and the supplemental endpoint's metadata-only role.
