# Horse fleet observations retain stable evidence indices

The bounded observer previously retained only population counts. Its private per-horse results were correctly deleted, but that made the observed identity set impossible to reconcile across later observations. Two population counts cannot establish their union.

The existing sanitized summary now retains a canonical cohort digest and one row per sorted cohort index, with accepted journal decisions, public-read classifications, qualified original-read counts and existing accepted phase-application counts. It retains source, window and serving-process bindings without printing horse IDs, cards or source payloads. Missing read classification remains unknown.

The offline `--union-ledgers` command combines only matching cohorts and source revisions from disjoint windows, deduplicates exact retries and refuses overlapping or mismatched evidence. Decision correctness, plan-effect persistence, profitability and whole-phase certification remain explicitly unverified. Earlier counts-only summaries are unchanged and cannot be silently added to the new evidence.

This changes the maintained observer control script only. Existing deployed engine CLI inputs remain compatible; no engine replacement, strategy activation, gameplay or database mutation is introduced. Focused Python contracts and CLI privacy/union checks cover the behavior.
