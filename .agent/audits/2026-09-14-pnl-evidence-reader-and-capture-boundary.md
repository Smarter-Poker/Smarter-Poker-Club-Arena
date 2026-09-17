# P&L evidence, posted payments, and the remaining capture boundary

This is source/native verification, not installation or financial activation. No P&L money function was called in production. No baseline, historical financial record, rate, issued invoice, or A–Q accounting body was changed.

The 45 native assertions below ran before the new Documents/AGENTS.md protected-compute policy took effect. They are historical evidence for the reader only. No further tests or builds have been run under the new policy. The subsequent P&L hook component and its new regression source remain UNRUN pending the protected pipeline; see `2026-09-14-pnl-quality-hooks-pending-protected-qualification.md`.

The candidate is `supabase/accounting/weekly-v3/components/20260914150848_union_pnl_evidence_is_distinct_from_posted_chip_payments.sql`. Its SHA256 is `d09383d8ca6a76aa1d42d99bc4646979f4e2d1adedda16b0e66d450e38b2bcac`. It adds read-only functions. It replaces no existing function and grants no table writes.

## What the reader establishes

`fn_union_pnl_evidence_report(union_id, start, end)` is a service-only diagnostic for a closed, bounded period at or after the September 7 floor. It reports exact opening and closing snapshot candidates, observed journal flows by the journal's recorded club, exact original-club wallet-refund evidence, source gaps, and separate posted P&L payment evidence. It does not read current seats, current membership, profiles, current tournament status or mutable tournament equity. Every player includes horses.

The report always says `basis_certified=false`, `payment_authorized=false`, and `status=blocked`. This is an explicit unsupported financial authority, not a pretend implementation of a payout calculation. Neither an empty result nor an exact boundary timestamp establishes complete historical coverage or snapshot provenance. Player profit and ECO amount remain null. The journal observations are partial discovery: missing historical union stamps, zero-rake hands, unknown source categories, prizes and open tournament equity require further evidence. No current club or table mapping is substituted for an absent recorded scope.

`fn_pnl_cash_hand_evidence(table_id, hand_number)` reads one actual `hand_atomic_commits` receipt and its linked accepted stack claim/final state. It validates complete exact-cent deltas, roster uniqueness, and conservation; preserves all players, including zero-rake and noncontributing players; and reports rake-attribution clubs only as corroboration. It never promotes those attribution rows to earning ownership. Explicit null rake/BBJ/inflow retains the installed writer's zero semantics; absent or malformed fields are different and remain gaps. Tournament play stacks are rejected as cash evidence.

The private `fn_union_pnl_posted_payment_evidence` checks an exact settled claim, final P&L state receipt, all club obligations, actual typed posted ledger legs, club balance deltas, exact totals, and one coherent paid/delivered source-ledger invoice per nonzero leg. An extra leg, partial payment, wrong club/union/payee, missing receipt, duplicate invoice or nonfinite evidence refuses a full chip-settlement label. A proven zero obligation says no chip movement. A proven payment still cannot certify the historical calculation that produced it.

The reader does not relabel or rewrite existing issued invoices. The old `fn_union_club_invoice` still requires a separate guarded upgrade before any UI or issuer can treat this report as its authoritative settlement evidence. The later source-only hook component blocks its ECO dependency, direct square-up/ECO issuance, union preparation and prior-success skipping while the basis remains uncertified; those hooks have not been qualified or installed.

## Actual installed source findings

Read-only production definitions on September 14:

| Source                              | MD5                                |
| ----------------------------------- | ---------------------------------- |
| `fn_ca_settle_hand_stacks_absolute` | `04e0218bf245c99a60b4d34f233c3b7a` |
| `fn_ca_commit_hand_settlement`      | `8c0acda3b19e958ecd5bbbc07c845afe` |
| `fn_stamp_seat_club`                | `467104f7e791b76328ce5e20b42ba81b` |
| `fn_union_club_invoice`             | `bee79493a9a724e043b658ba328d663f` |
| `fn_union_eco_adjustment`           | `4bef87530456c7c0d291c59c70eb41cd` |

The accepted stack writer keeps each player's canonical `user_id`, `stack`, `stack_before`, and, for exact generations, `seat_id`/`seat_joined_at`. It does not keep every participant's original funding club, union or asset identity in that canonical request. Its union/cash receipt time and club ownership cannot be recovered safely from current membership. One bounded live example, hand 10981144, had two participants, two delta inputs, two exact seat-generation inputs, and zero recorded participant clubs. Its durable atomic result matched the succeeded stack claim exactly. This is a one-hand observation plus an installed-writer contract inspection, not a weekly coverage measurement.

`ca_hand_facts` is intentionally human-only and cannot account for horses. `hand_history` reconstruction excludes blinds/antes from voluntary contribution and is pruned after seven days. `ca_hand_financial_facts` preserves aggregate rake/BBJ/winners rather than every player's delta and has a 90-day retention design. None is a complete substitute for durable accepted cash financial facts.

The current seat stamp retains a club when user/table/club are unchanged. That optimization is not proof that every historical generation's club can never change or disappear. The exit audit preserves some original club data, but only positive cash exits; it omits zero stacks and has no complete per-hand coverage. Cash-game roster tracking contains user/game membership, does not record funding club, and catches errors as warnings. These are corroborating records only.

Tournament funding has stronger original-source records: `tournament_refund_entitlements` identifies the original wallet club and exact debit; `tournament_refund_tranches` identifies the returned instrument, exact credit ledger, amount and original club. The diagnostic checks wallet-funded refunds by those exact relationships. Ticket and satellite instruments require separate custody accounting and are not mislabeled as wallet refunds. A refund returns funding and is not player winnings. The diagnostic includes `addon`/`rebuy` funding observations, which the old wallet-category reader omitted.

Tournament prize/bounty ledger rows prove that a recipient wallet was credited. That destination club is not automatically the event's original earning club, especially across reentries or club changes. `tournament_payouts` and obligations are insufficient alone: payout status or amount-paid counters do not supply the exact immutable ownership/coverage bridge. Accepted tournament play-stack changes are not cash profit. Opening and closing in-flight tournament equity need a signed instrument-level basis; a currently running event's mutable counter cannot supply it.

The current ECO reader sets its exactness flag true when the previous baseline is null. Its cash baseline can fall back from `seated_end_cash` to another seated field, and the old source population can use current membership. The current invoice reader derives `settled_in_chips = player_pnl_net + rakeback_due`; it does not prove P&L transfers. An amount calculated by these functions is not evidence of a payment. No rates or economic interpretation were changed here.

## Safe forward capture design, requiring the hand-owner integration lane

The correct capture boundary is the existing atomic hand acceptance transaction. `fn_ca_commit_hand_settlement` already binds lease ownership, stack settlement, accepted history and its durable post-commit envelope. Its stack owner locks live target seat rows in row-id order, verifies exact user/seat/joined-at identity, computes the delta, preserves concurrent funding rebases, and records departed-player wallet legs. Capture must use those same locked source values, before they are discarded, rather than rereading current seats in a later daemon.

The needed append-only parent receipt must bind `(table_id, hand_number)`, actual history hand id, synthetic stack-settlement hand id, accepted request hash, exact accepted/earning time contract, asset, historical game union, roster count, rake, BBJ, inflow and net delta. Every participant child must bind user, exact seat generation/occupancy, before/after/net delta, original funding club and immutable source proof. Zero deltas, zero rake, horses and noncontributors are mandatory rows. Unique source keys and a roster fingerprint must make replay compare the complete original request, never append missing players from new current state.

An exact seat row observed at acceptance helps, but alone does not prove original funding ownership if that generation's club was changed before acceptance. The owner must establish an immutable same-generation club rule or an exact custody/funding receipt chain covering admission, add-ons, moves and exits. Existing entry purchase receipts record the requested club; their precise occupancy and move linkage requires audit before being promoted to an ownership certificate. Departed-seat credits must link their original club proof and actual payment receipt. Absolute-mode or pre-contract legacy requests must remain explicitly uncertified.

Do not insert a global accounting lock into a live hand while it holds unrelated bank/seat locks. The hand-owner lane must coordinate the existing source-period lock order before any financial locks, or use a durable per-hand capture state plus a close-boundary barrier that sees every accepted hand. Known recorded union/game scope blocks only the affected book/week when evidence is missing; private legacy sources with unknown historical coordinator must retain an unknown-scope blocker. A gameplay settlement that is accepted without complete accounting ownership must leave an immutable blocked capture receipt in the same transaction, not silently disappear from weekly accounting. Complete accepted-cash coverage must be reconciled before a weekly P&L certificate is written.

Once complete capture exists, hand delta aggregation can calculate cash play results without taking today's seats as historical closing equity. Existing cash-flow/snapshot reconciliation remains an independent comparison and must classify buy-ins, add-ons, returns, departures, BBJ and other non-play movements exactly once. No historical gap may be filled by an invented opening balance. Tournament instrument/equity recognition and the agreed ECO basis remain separate required inputs.

This design is not implemented by this bounded reader change. It crosses the F06/hand-owner contracts and needs that owner's actual writer fixtures and concurrency proofs. Historical reconciliation, certified boundary/coverage receipts, tournament earning attribution/equity, ECO economics, issuer wiring and actual P&L activation remain open.

## Native verification

`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.bare GIT_CONFIG_VALUE_0=false bash scripts/dev/test-pnl-evidence.sh` passed **45 assertions** against the actual new SQL functions in PostgreSQL 17. The schema/financial records are controlled fixtures, not production payments. No fake P&L reader is substituted for the candidate.

Coverage includes stale/absent/duplicate exact boundary candidates; full and partial payment evidence; wrong union, invoice payee and cent amount; nonfinite/broken balances; duplicate/missing invoices; zero-obligation labeling; total/extra-leg mismatch; horses and zero-rake participants; missing/duplicate/invalid hand inputs; current-seat/current-membership/current-tournament poisoning; original-club refunds after membership changes; add-ons; unsupported prize ownership; refund source and instrument mismatches; half-open time bounds; duplicate credit reuse; privilege checks; and execution inside a read-only transaction with unchanged claim, journal and invoice hashes.

Native definition MD5s:

| Function                               | MD5                                |
| -------------------------------------- | ---------------------------------- |
| `fn_pnl_evidence_cents`                | `8d712bd799c3dfa691f2d8d9ff5101e8` |
| `fn_pnl_cash_hand_evidence`            | `dbfd6a81a39c1c552efccfde3049aa4c` |
| `fn_union_pnl_evidence_report`         | `501b5a243800f96ef549aa4b137bc7bf` |
| `fn_union_pnl_posted_payment_evidence` | `58fba36103ba1b8034453f6cac14a86c` |

The component remains unapplied. Its report is deliberately not a claim that union P&L/ECO/square-up is complete.
