# Phase 3 satellite award funding evidence

Date: 2026-09-10. Candidate only; no production SQL was applied and no branch was pushed.

Later installed-authority reconciliation and one additional composition proof are recorded in `2026-09-10-phase3-satellite-award-source-reconciliation.md`. The hashes and eight-group results below describe the original rehearsal.

## Controls

| Control | Result | Remaining acceptance |
| --- | --- | --- |
| B07: funded seat transfer, target escrow, exactly once, both identities | Partial overall. The actual installed award helper and funding authorities pass the isolated cases below after the candidate correction. | Production application and installed-body verification remain pending. This does not certify the enclosing terminal delivery graph. |
| B09: target closure/concurrent entries, seat or approved cash alternative | Partial overall. Actual locks serialize the tested helper paths and paid registration. | The upper delivery authority and its approved cash payout alternative are not executed here; closure uses a controlled finalized-field update. |

## Reproduced defects and prospective correction

Two source entries each pay 200 through the actual registration request, wallet debit, immutable entitlement and ledger authorities. Four fixture wallets start at 500 each, so the two entries leave wallets at 1600, source prize escrow 360 and source fee escrow 40. No wallet-transaction rows or financial balances are inserted to fake those entries.

1. The current enabled roster trigger already counts an inserted pre-start satellite qualifier. The award helper increments the count again: one target entry produced `current_players=2`. The correction retains that trigger's pre-start result and preserves the helper's RUNNING increment.
2. The version 2 transfer excludes its fee from gross escrow input. The current rake trigger subtracts that same fee again: a 180-prize/20-fee target held prize escrow 160. The correction skips the second subtraction only for version 2; missing or legacy metadata retains the existing subtraction.
3. The escrow reader's direct-bounty LEFT JOIN treats its empty placeholder as a bounty contribution because PostgreSQL `LEAST` ignores NULL arguments. An unfunded 5-bounty target starts with a phantom 5 bounty; after a real seat transfer, tournament pools were 175 prize/5 bounty while escrow held 170/10. Changing that join to an inner join makes the ungrouped aggregate emit zero for no matching entries and preserves matched-entry calculations.

Migration: `supabase/migrations/20260910043237_satellite_seats_count_once_and_keep_the_funded_prize.sql`. It replaces three functions transactionally with old-or-corrected body guards and verifies the enabled current roster authority. It does not rewrite historical ledger rows, counts, escrows, receipts or wallet balances. Future escrow calculations for existing events can change when the corrected reader is called; this is not a balance-neutral change.

| Authority | Captured installed body MD5 | Candidate body MD5 |
| --- | --- | --- |
| `fn_award_satellite_seat(uuid,uuid,uuid,text,integer)` | `b0a05e8e90bced99d121375c9a7b9c88` | `92188570fbbac357ad55d83fb0e7a456` |
| `fn_ca_escrow_on_rake_record()` | `233661d2164a417c2a76c8e0cbfbe9cc` | `3e628d6a57a93eeb61d494ee33f989a3` |
| `fn_ca_tournament_escrow(uuid)` | `99606ee5149e6734e99c9d4917a126ee` | `e13df51254ce46a49b1bf1f0e476599e` |

The live catalog was read only. The fixture pins 12 additional installed authorities and three reused financial authorities before applying the candidate. The roster body is `ecb120c2c6a4ecee6c2e04d4c9b5ebc7`. Independent read-only peer review found no concrete defect in the three changes; it specifically checked RUNNING counts, legacy fee semantics and no-data aggregate shape.

## Behavioral results

All eight planned groups passed in isolated PostgreSQL 17, resumed as 3 + 3 + 2 groups to avoid repeating unchanged passing cases. Group 1 runs three target states, so the eight groups cover ten successful scenario executions.

| Group | Observed result |
| --- | --- |
| Admitted states and replay | REGISTERING, ANNOUNCED and RUNNING each produce one qualifier, one transfer, one payout receipt, target count 1 and escrow 180 prize/20 fee. Replay after target finalization changes none of the 11 fingerprinted relations. |
| Bounty target | Empty reader emits one row with balances 0/0/0. A funded award produces 175 prize/5 bounty/20 fee in both tournament counters and escrow; the reconstructed reader agrees. |
| Late receipt failure | A local failure trigger on the final payout receipt aborts the award. All 11 fingerprinted relations equal the pre-call state. |
| Insufficient source | One actual paid entry provides 180 prize, insufficient for the 200 seat. The existing transfer split trigger refuses and all 11 relations remain unchanged. |
| Same award overlap | Two overlapping requests commit one funded seat, transfer and receipt; the contender reports the existing seat's same-satellite provenance. |
| Target closes first | A competing finalized-field update commits while the award waits on a real lock. The contender reports `target_pool_finalized`; no target entry, transfer or receipt appears and source prize remains 360. |
| Last available place | Two actual paid target entrants occupy a legal capacity-three event. Two funded qualifiers race for its final place; one award commits and the other returns `target_full`. Target count is 3, prize escrow 540, fee escrow 60, wallets 1200 and source prize 160. |
| Paid target entry wins | Actual paid registration commits before the waiting award. The latter reports `already_registered` and `held_from_this_satellite=false`; wallets are 1400, source prize remains 360 and no satellite transfer or payout receipt exists. |

The four overlap groups require an observed PostgreSQL `wait_event_type='Lock'` before releasing the owner transaction. Successful transfers assert source and target identities, payout/ledger registration linkage and gross amount 200. Ordinary successful awards leave wallets 1600, source prize 160, source fee 40 and target components totaling 200, conserving the initial 2000.

The 11 fingerprinted relations are tournaments, tournament players, tournament escrow, chip ledger, chip-ledger idempotency, club wallets, rake records, tournament payouts, wallet transactions, refund entitlements and entry-purchase idempotency receipts.

## Reproduction and retained evidence

Run through the existing registration runtime after integrating its explicit selector from the entry/cancellation lane:

```bash
python3 scripts/dev/probe-tournament-registration-funding-pg17.py --satellite-awards-only
```

This lane used a temporary in-memory composition of that identical selector, without editing or copying the shared runtime or dependencies. The first three and next three passing groups were retained when later fixture expectations failed; temporary resume launchers executed only the remaining source cases. `results.json` from the final invocation lists only its final two groups, not all eight.

Local evidence on the Mac:

- `/tmp/codex-phase3-satellite-award-baseline.log`: actual installed count and fee mismatch.
- `/tmp/codex-phase3-satellite-award-fixed.log`: first two corrections pass admitted states, then reproduce the phantom bounty mismatch.
- `/tmp/codex-phase3-satellite-award-fixed-all.log`: first three groups pass with all three corrections.
- `/tmp/codex-phase3-satellite-award-fixed-remaining.log`: next three groups pass.
- `/tmp/codex-phase3-satellite-award-fixed-last-two.log`: final two groups pass and the runtime exits successfully.
- `/tmp/ca-registration-funding-pg17-c10oxeg0/results.json`: final two group's structured result.

Fixture corrections, not application changes: added the captured nullable `rake_records.terminal_closed_at` column required by an actual immutable-rake guard; expected the actual earlier insufficient-transfer rejection; used capacity three with two real paid entries because capacity one at this fee violates the existing heads-up rake constraint.

## Limits

The fixture reuses actual installed registration, wallet, entitlement, ledger, escrow, refund and selected immutable/admission trigger bodies. It is not the entire production trigger, foreign-key or permission graph. Authentication identity and lifecycle setup are controlled; source COMPLETING state and target finalization are fixture transitions. Three empty terminal-receipt table shapes support read-only guards, and no terminal settlement is invented.

The outer `fn_deliver_satellite_ticket_exact` route, its separate four-table delivery policy, approved cash payout, terminal plans, HTTP/RLS authorization and subsequent live chair assignment are outside this proof. No historic backpay, balance repair or financial alert resolution was attempted. Existing satellite refund groups and the six earlier mystery activation tests were reused as separate evidence, not rerun here. B07, B09 and Phase 3 are not claimed complete or live.
