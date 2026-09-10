# Short Formats Continue Their Approved Blinds

K01 remains open. This change fixes the short-format arithmetic shared by the engine and current-blind SQL readers. It does not make level, anchor, and table publication atomic.

The approved Heads-Up specification ends its published ladder at level 12 with 200/400, then continues by 1.4 per level with the big blind rounded to ten. The manager instead used the generic MTT overflow and chip cap. Real manager execution and captured installed SQL both reduced the next big blind to 30 in a 300-stack duel or approximately 100 in a 1000-stack duel. At level 13 the approved result is 280/560 in both bands. The existing generic SQL arithmetic sometimes produced 29/99 through decimal flooring; changing generic MTT arithmetic is outside this correction.

The manager now calls the existing `headsUpBlindsForLevel` authority for SNG overflow. Persisted structure rows retain precedence. SNG identifies the already-approved two-player product, not a new tournament format. Spin overflow continues to honor the funded draw's stored continuation. The reviewed SQL proposal adds the same stored Spin precedence and approved Heads-Up formula while leaving the generic MTT branch unchanged.

The installed SQL's Spin formula already matched all 80 approved Spin cases, eight tiers, both 300/1000 starting stacks, and five selected late levels. The one Spin disagreement is a deliberate compatibility fixture whose stored growth is 1.3. It proves that a future formula change cannot overwrite the booked draw. It is not a proposed product-rule change or evidence that current production Spin tiers were mispriced.

## Verification

- `python3 scripts/dev/probe-blind-authority-pg17.py`: 91 actual manager/SQL cases, no proposed mismatch. The installed SQL has eight Heads-Up mismatches and one frozen Spin compatibility mismatch.
- The same disposable PostgreSQL 17 run preserves all 60 generic MTT cases byte-for-byte as JSON results; rejects ten malformed stored continuations; verifies the missing function, changed function body, and changed privilege preflights; verifies legacy Spin fallback and SNG identification by either persisted discriminator.
- `server: npx vitest run src/tournament/HeadsUpBlindContinuation.test.ts src/tournament/SpinDrawReceipt.test.ts src/tournament/BlindLevelTransitionRecovery.test.ts`: 14 tests passed across three files. The new Heads-Up test reproduced the level-13 regression before the source correction.
- `server: npm run build`: TypeScript build passed.
- Evidence: `docs/audits/2026-09-10-phase3-short-format-blind-authority.json` includes source hashes, actual matrix rows, and the installed/proposed body fingerprints.

## Deployment Contract

Proposal `20260910070354_short_format_blinds_continue_their_approved_rules.sql` is a single short transaction. It requires the installed resolver body `b5769b647e5b106caaf51982ac245ee8`, its existing security-definer search path, and its exact postgres-only ACL before replacing anything. The proposal preserves that ACL and asserts the new body `9c80eddf5784982bad2585ec39cca0ad` afterward. The current public wrapper remains service-only. No production DDL or data writes were performed by this lane, and the engine changes have not been published by this lane.

Roll out the reviewed database correction before normal engine adoption, then verify actual live versions and actual short-format levels. This local proof does not satisfy the remaining K01 atomic clock publication, stale writer, maintenance, late response, or live acceptance requirements.
