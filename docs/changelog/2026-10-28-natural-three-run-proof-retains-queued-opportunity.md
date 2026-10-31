# Retain natural three-run proof opportunities across provider queues

The target-three live observation in run 40786899441 reached cohort selection more than 55 minutes after the verified three-run hand. Its 30-minute history window had expired, so the selector silently chose a crowded table with no three-run history and observed no RIT decisions. The failed verdict and successful cleanup remain retained; this change does not certify live behavior.

Use a bounded two-hour indexed lookback and require positive actual three-run history for target-three selection. Keep the existing maximum 32 candidate tables, 500 metadata rows per table, four concurrent lookups, public metadata projection, generic two-and-three selection and live acceptance assertions. No engine, gameplay, table setting or production UI changes.

Validation: the targeted regressions failed before the helper change (3 failed, 69 passed), including replay of the actual queue-time age and refusal of a quiet fallback. All 72 focused naturalMultiRunMobile tests and strict helper TypeScript pass afterward. A fresh natural live observation is still required after protected merge.
