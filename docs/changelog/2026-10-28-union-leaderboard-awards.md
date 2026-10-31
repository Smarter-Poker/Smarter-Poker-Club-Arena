# Union leaderboard prizes read the players' physical play

Deep Stack Society joined Midway Union on October 12. Its open leaderboard
already ranked its home players across union tables, but closed prize rounds
still read only the club's idle standalone counters. The October 18–25 round
therefore recorded zero winners despite 3,357,775 captured union-root hands
for its home players. The prior October 11–18 round has zero qualifying hands
across that same physical scope and needs no payment.

Closed rounds now use the same earliest-joined home attribution across the
union's physical scope, with exact complete opening and closing captures.
The receipt freezes the resolved roster, scope and inputs so later membership
changes cannot rewrite a paid board. Standalone selection is unchanged.
Original batches, basis receipts and published programs remain intact.

A linked immutable correction pays the published prizes for October 18–25:
echobellamy, 24,786 hands, 250 Chips; jasperjamison, 22,889 hands, 150 Chips;
runequintero, 22,647 hands, 100 Chips. All three are horses. The correction uses
the original per-player credit keys and actual credit function, debits only
Midway's Promo wallet, and writes ordinary player payout receipts. Status and
replay readers expose the correction and effective totals without rewriting
the original empty batch. Exact batch, basis, roster, input and winner
assertions abort if the verified case changes.

A funding-only version carries the same 250/150/100 Chip weekly prizes and
empty monthly prizes forward under Midway's Promo wallet. Version1 named the
former standalone wallet, whose balance became zero on union admission. No
operating-bank overlay, mint, extra prize program or scheduled repair is added.
The system publication has no human publisher identity.

Validation includes a single self-aborting production transaction using the
real wallet and ledger functions, checking deferred constraints before
rollback. Readback confirmed zero retained keys or payout receipts. No
production DDL was probed. Native PG17 reproduces the zero-winner defect,
installs the source correction, tests partial-credit rollback, original-record
preservation, append-only correction, access control, corrected rankings,
prospective real-owner payout, underfunding refusal, replay no-op and frozen
roster behavior. The existing directly triggered financial workflow runs it.
Native fixtures rebind only the three production-data hash assertions to
synthetic inputs; actual production hashes are checked by the rollback probe.

## October31 recovery

Chat01a190a6 recovered existing unmerged PR8452 in an isolated SSD worktree.
Readback06:44:12Z preserves original empty batch0b5cebb0, programcf1e2a57
version1/hash6cccd5b70afc93983c8419ec15c2f707, no original per-player credit
keys, no correction table, and Midway Promo208241.57. The three exact function
preimages remain unchanged. No payment, DDL probe or financial replay occurred.
Native PostgreSQL17 reproduced the zero-winner bug and passed original-record
preservation, partial-credit rollback, actual ranking/payer/funding owners,
500-Chip correction/prospective payout, replay, frozen roster and ACL metadata.
All17 affected source contracts pass after replacing an obsolete comment-only
assertion with executable CREATE OR REPLACE, no DROP and explicit service-role
permissions. Both original Monday and union native steps and all newer weekly
quality commands are preserved; reviewed workflow binding keeps historical
qualification status unchanged. Policy2.9 manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b
loaded under overall chat audit. Protected checks, merge, exact installation
and receipt readback remain outstanding; the correction is still unpaid.

07:42Z protected main integration preserves Monday recovery audit and its additional Chicago assertion, both independent native qualifiers and both historical binding audits. Union migration/financial fixture bytes are unchanged; no prior native outcome is restamped.
