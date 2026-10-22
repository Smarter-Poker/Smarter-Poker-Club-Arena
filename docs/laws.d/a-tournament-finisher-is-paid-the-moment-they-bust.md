# tests/a-tournament-finisher-is-paid-the-moment-they-bust.law.test.ts

Dan, 2026-10-21: a tournament finisher in the money gets their chips the
moment they bust, not at the end of the tournament. The commit that records a
bust runs `fn_ca_pay_tournament_finishers_now` (a deferred constraint trigger
on `playing -> eliminated`, and another when the prize pool finalizes). Only a
RUNNING event with a finalized pool is paid; satellites, final-table deals and
place batches keep their own authority, and nobody is paid while a bust is
still unrecorded. The place is the terminal settlement's own rule (when the
bust happened, then the smaller same-hand stack), unpaid provisional places are
restamped to it, and a paid place is never relabelled. Money moves only through
`fn_ca_settle_tournament_place_raw` and `fn_ca_settle_tournament_bubble_raw`,
the idempotent obligation doors the terminal uses, so the terminal finds those
places exactly settled. A refusal never blocks the bust: it rolls back only the
payment, is recorded once in `financial_alerts`, and the terminal pays it.
