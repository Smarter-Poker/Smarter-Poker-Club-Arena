# One Focus Edge Per Data-entry Field

Search, text, number, select, textarea and editable fields use one inset focus edge on the existing painted control or its compact wrapper. The global entry point installs and disposes the focus handler; checkbox, radio, range, button and link focus remain separate. No values, validation, authorization, requests or gameplay state change.

Validated the portable handler with five state/lifecycle regressions and real-browser wrapped/standalone field checks. Publication and live identity are recorded in the task checkpoint.

2026-10-16: the Production Build initial-load gate measured current `main` at its 320kB gzip ceiling on its own, and this change at 321kB. The helper and its stylesheet now load together as one deferred chunk from `src/main.tsx` (through `importWithRetry`) instead of riding in the entry, and the entry-chunk fragment is withdrawn because neither module is in the entry any more. The stylesheet only applies under the root marker the helper sets, so the two cannot disagree, and the helper adopts a field that was already focused when it installs. The standalone Diamond test entry still installs eagerly. The law test pins the deferred wiring.
