# Horse Phase 7 closure record

Phase 7's G1 to G10 ledger is now written into [the Phase 7 build plan](../horse-brain-phase7-build-plan-2026-09-30.md#closure-ledger-october-1-2026), with source identities and artifact paths. This is a documentation change only: no engine, migration, test or production configuration changed.

Publication: the live engine reports `2a8ac77c` (`2a8ac77c1cf4f58658b043cb0746ab1cc3e8bcda`, 0 commits behind main at 15:00 UTC). The protected merges of #5660 (`031724d4`), #5662 (`bc30e60c`), #5672 (`8068df7e`), #5677 (`c97b54c9`) and #5688 (`733da83e`) are all ancestors of it. The observation-window migration `20260930233329` is recorded and its columns exist.

Natural evidence: a bounded journal observation on the live release (accepted hands from 14:50 to 14:55 UTC) reconciled 1,024 hands and 1,151 Phase 7 receipts: 1,118 verified intended accepted decisions and 33 second-look retirements. Every receipt matched its original read frame. There were no invalid, unreconciled or conflicting results, and every receipt was single-board. The earlier `8068df7e` sample (414 hands, 785 receipts, 770 intended, 15 retired) is retained alongside it.

7B check at 15:02 UTC: production has 0 bomb-enabled or multi-board tournament tables out of 375,654 tournament tables. Since the live engine started there have been 0 bomb-pot or multi-board tournament hands among 37,896, and 0 multi-board Phase 7 receipts. Nothing was created to manufacture the proof.

Verdict: **7A is complete**, with the uncalibrated response model, the unavailable counter isolation and the bounded, finite samples kept visible as limits. **7B is open on one gate.** Implementation and publication are verified, but natural joint-input to accepted-action proof is an unavailable dependency until an independently configured eligible tournament population exists.
