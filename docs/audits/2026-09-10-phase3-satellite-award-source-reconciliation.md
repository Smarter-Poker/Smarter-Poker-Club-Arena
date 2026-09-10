# Satellite award authority reconciliation

Date: 2026-09-10. This updates the unapplied candidate from commit `185b74cc45195f5c7338d29ecc9824509bd4bf09`. No production SQL or branch push occurred.

The current installed award changed after the eight-group rehearsal. A read-only catalog capture confirmed exactly one difference from that rehearsal's installed body:

```diff
-  PERFORM pg_advisory_xact_lock(
-    hashtextextended('ca:tournament-terminal-settlement:v1',0));
+  PERFORM public.fn_ca_lock_settlement_lane_global();
```

The actual current helper takes the terminal-global G lock followed by the hand-settlement B barrier, both transaction-exclusive. The recomposed candidate retains that helper call and its order. It still changes only the previously proved pre-start count expression inside the award. The rake and escrow-reader corrections are unchanged.

| Authority | Current installed body MD5 | Candidate body MD5 |
| --- | --- | --- |
| Award | `cc53a9560c7b211c9c052a186dabc96c` | `2c21c56c6a9d4a2f8ee79082bd4fef57` |
| Global lane helper | `343015440ea5c84ee4ca7ae583c73d30` | Unchanged; required dependency |
| Rake escrow trigger | `233661d2164a417c2a76c8e0cbfbe9cc` | `3e628d6a57a93eeb61d494ee33f989a3` |
| Escrow reader | `99606ee5149e6734e99c9d4917a126ee` | `e13df51254ce46a49b1bf1f0e476599e` |

The migration now accepts only the current installed or recomposed award body and requires the captured global helper body. It does not replace that helper. The fixture contains its actual definition and now pins 13 additional installed functions, preserving the seven selected triggers and three reused financial pins.

One changed-composition PostgreSQL 17 group passed:

```text
PASS reconciled award applies twice waits on hand barrier funds once and replays after closure
1 groups passed; evidence: /tmp/ca-registration-funding-pg17-tb4i04q7/results.json
```

This group applies and reapplies the recomposed migration. Two source entries pay through the actual registration/financial authorities. A controlled owner transaction holds only B while the award contender is observed waiting on a real database lock. After release, the award commits one qualifier, one 200 transfer and one receipt, with source prize 160, target prize 180, target fee 20 and wallets 1600. After target finalization, replay reports the same-satellite seat and changes none of the 11 fingerprinted relations. The B holder is a deliberate lock fixture, not a simulated hand-settlement proof.

Reproduction through the existing registration runner's explicit satellite selector:

```bash
python3 scripts/dev/probe-tournament-registration-funding-pg17.py \
  --satellite-awards-only --satellite-lock-reconciliation-only
```

Local execution used the same temporary selector composition as the original rehearsal; the shared runner was not edited. The original eight passing groups and their historical hashes remain in `2026-09-10-phase3-satellite-award-funding-evidence.md`. They were not rerun because the financial expressions did not change. The additional group resolves the changed helper composition only.

Production application, current-body verification after application, outer delivery/cash alternatives and the full hand-settlement graph remain unverified. No historical rows are rewritten by this candidate, but future escrow-reader calculations for existing events can change. B07/B09 remain partial overall.
