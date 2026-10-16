# Spin conservation includes its reserve

The scalar `fn_tournament_conservation_delta(uuid)` counted entries, prizes and rake but omitted Spin reserve movements. A 30-chip event with 3 rake and a 20 prize therefore reported 7 retained, although its reserve received 27 and paid 20.

Migration `20261015212119` subtracts the signed sum of that event's `contribution` and `jackpot_draw` reserve legs. Seed repayments and adjustments are unrelated reserve-owner movements and remain excluded. The existing Diamond-book branch takes precedence. The one-pass conservation scan already excludes Spins, so it needs no arithmetic change. No money or alert is written.

The exact scalar preimage and single replacement are retained under `scripts/ci/fixtures/backed-payout-scan/spin-reserve-*`. The guarded transaction pins before/after hashes and preserves owner, ACL, volatility and search path. Native PG17 qualification reproduces the false positive before installation, proves low/high multipliers afterward, detects missing/wrong funding, preserves every non-Spin and Diamond fixture result, and checks rollback, freeze, replay and authority. The required accounting CI shard runs that qualification.

This follows already-merged PR #7003; it does not amend that historical migration. Installation and production verification remain separate from local qualification.
