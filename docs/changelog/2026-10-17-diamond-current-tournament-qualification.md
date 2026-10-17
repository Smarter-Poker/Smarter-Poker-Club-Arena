# Diamond current tournament qualification and freeroll purchase fee

PR #7021 passed all six exact-head required checks, merged as `42a6924b032c5b0c1b3e1c1454f14825dd9e4257`, and published in containing client `20dcb254620b1e0f9a3584bb4ab8d6ac6574f22a` through publisher `38998727441`. Both origins matched. The final client passed 22 authenticated Chromium/WebKit route cases, one natural cash hand/network recovery case, and one natural MTT level-change/recovery case, with no skips, failures, flakes or retries. Each disposable identity was hard-deleted and absence verified.

The read-only maintenance observation retained identical funded custody/seat fingerprints at 03:56:27 and 03:57:49 UTC. The same engine instance resumed all 333 tables in eight waves; Postgres thawed and all 15 Diamond health areas returned OK. Seven-day accounting retained 168 complete readings/snapshots with zero unexplained snapshots or critical incidents. This observed freeze/thaw, without an engine replacement, does not certify failover or funded rollback.

## Current qualification gap

The 121 historical tournament function pins matched 93 current production definitions and differed on 28. Newer current concurrency qualification already covered several differences; the historical lifecycle capture alone could not qualify the rest. Preserve every historical capture and case. The scheduled native runner now prepares a second independent disposable PostgreSQL17 scene with current captured authorities, execute permissions, security settings and relevant CHECK constraints. Current inputs are SHA256 bound and definitions/metadata are checked before running actual money paths. No production money operation is used for this qualification.

## DA22: a 100-Diamond freeroll rebuy exposed the old fee fallback

The deployed purchase function `fn_ca_process_tournament_chip_purchase_money_v1`, full MD5 `2077904b2bfc2c99287ad824548b3e92`, derived a 10% recovery ratio from zero entry prize/fee. At the old 1-Diamond rebuy, whole-Diamond truncation produced zero fee. At the October16 price of100 Diamonds it produces a 10-Diamond fee, despite the recorded freeroll economics answer that the whole 100 goes to the prize pool. The current native test calls the actual purchase authority, not the lower-level custody charge that accepts an already-computed split. It fails before repair at the zero-fee assertion.

Production read-only inventory found zero fee-bearing Diamond freeroll rebuy/re-entry receipts across retained history, so there is no observed payment correction to perform. The migration refuses if that inventory changes before installation.

Repair the shared purchase ratio for zero-entry Diamond events, apply it to both purchase and refund reconstruction, and use the same unit-aware ratio in player and horse quotes. Preserve chip fee behavior, paid Diamond ratios, idempotency, ownership, grants, search paths, timeout, settlement/custody and historical records. The migration pins both preimages/postimages and retains authority metadata. Installation, current qualification, protected delivery and new live proof remain pending until their actual receipts exist.

The broader launch verdict remains incomplete: dedicated funded buy-in/hand/leave/transfer, remaining format subjects, failover and funded rollback/restore certificates remain separate gates. No launch-ready claim is made.

Local qualification: 77 native PASS lines across the independent historical and current 134-authority / 22-CHECK scenes, including the actual purchase, refund reconstruction, duplicate request and migration replay refusal. The player quote regression failed three cases before repair; 178 focused client assertions and 49 engine assertions pass after repair. Both TypeScript compilers passed. No production installation or new release is claimed by these local results.
