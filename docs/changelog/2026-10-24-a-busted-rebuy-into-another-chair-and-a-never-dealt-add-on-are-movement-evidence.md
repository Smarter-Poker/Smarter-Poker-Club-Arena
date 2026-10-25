# A Busted Rebuy Into Another Chair, And A Never-Dealt Add-On, Are Movement Evidence

Two latent gaps in the tournament park proofs, closed before either froze a live event, plus one tightening of the refunded-entry rule. Migration `20261025030421_a_busted_rebuy_into_another_chair_and_a_never_dealt_add_on_a.sql`.

## G2: busted in the proven hand, bought back into another chair

`smarter_private.f06_movement_prior` (live md5 `ddbca56b`) proves a parked table from its last sealed hand. A player that hand wrote to 0 who then rebought or re-entered is followed through the purchase loop, which raises the held stack to the grant; the seat lookup then accepts only the chair the hand dealt (or the same chair row re-occupied). `process_tournament_rebuy` lets `fn_ca_choose_tournament_seat_locked` choose the table with the most free chairs, so the new chair is usually elsewhere. Read from rows: the last five rebought knockout candidates (02:27-02:52 UTC) were all seated in a different chair on another table, and three of the five old chairs were already somebody else's. Such a park would refuse `F06_MOVEMENT_SEAT_CHANGED` for ever.

The fix reads the purchase's immutable result (`entry_purchase_idempotency_receipts`, `tournament_chip_purchase`, keyed by the first purchase since the hand): v1 atomic purchase, seated, candidate `rebought` from 0 in exactly this hand, on this table, from the chair this hand dealt, granting exactly that purchase's chips, into a different chair. The old chair must hold nothing of the player (vacated at 0, or taken since by another occupant whose own rows prove it).

- New chair on this table: that chair row becomes the seat and every existing check (stack = receipted chips, registration on that chair, roster counts) runs unchanged. It is counted once, since the arrival loop skips players the hand dealt. Recorded under `receipts.rechaired`.
- New chair on another table: the player departed by the rebuy. Its registration must be playing on exactly that table and chair, it must sit in exactly that chair row, and it must hold no open chair here. Recorded under `receipts.departed`; neither roster nor eliminated.

## G3: an add-on on a chair that never dealt

`smarter_private.f06_movement_never_dealt_prior` (live md5 `63184403`) refused any add-on: `entry_proven` rejects an add-on receipt, flag or ledger leg, and the rebuy and arrival rules reject any later receipt. Now, when the rules refuse the chair as it stands and the registration's latest receipts are add-ons admitted exactly as the dealt proof's purchase loop admits them (grant = event add-on chips or starting chips, registration image = running stack, all after the receipt before them), the rules are taken once more on the chair as it stood before those add-ons: stack and registration chips less the grants, add-on flag clear, the receipt before them as the funding receipt, exactly those receipts and their own ledger legs set aside, and an arrival's add-ons all after its move. The roster still carries the live rows; the entry lists the add-ons under `addons`.

## R: the refunded earlier entry must predate the registration

The rule from `20261024232734` admitted another receipt of the player if observed before the current receipt. It must now also be observed before the current registration's `registered_at` (and a registration with no `registered_at` admits none). The live case (c06ca679, 5ba8dd2b: receipt 18f34c67 at 2026-10-23 10:46, registration d4c788b7 at 2026-10-24 22:51:47, refund 10.00) still qualifies.

## Proof

- Both edits are anchored insertions into the installed definitions, md5-guarded before and after. Removing every inserted passage reproduces each pre-image byte for byte; the migration asserts it before installing, and the law test rebuilds both pre-images from the migrations that installed them and reproduces the post-image md5s.
- Live (CLAUDE.md 11.5): one Supabase MCP call, the live text read and patched in the call (post-image md5s matched), old and new installed as `pg_temp` copies with row locks stripped, transaction switched READ ONLY, both run on every open `park_requested`/`begun` `f06_operations` row, ending in RAISE: `same=38 diff=0`.
- Local throwaway PostgreSQL 16 (only the columns these readers read, both live definitions loaded with md5s identical to production, this migration applied): G2 departed (rebuy and re-entry), G2 same-table rechair, G2 departed with the old chair re-taken by a receipted arrival all refuse under the old proof and are admitted by the new; five G2 negatives (registration elsewhere, still holds a chair here, candidate from another hand, old chair open with chips, result stack differs) refuse under both; a same-chair rebuy and a plain bust are byte-identical. G3 entry plus one and two add-ons, arrival plus add-on, never-dealt rebuy plus add-on, and the refunded live shape plus add-on are admitted by the new proof only; four G3 negatives refuse under both; no add-on, an add-on before an arrival's move, and a never-dealt rebuy with no add-on are byte-identical. R: the live shape is byte-identical; a prior receipt after the registration was made refuses only under the new proof.

No row is written and no chip moves. Once installed, the engine's existing park re-admission takes the proof. No repair job.

Pinned by `tests/a-busted-rebuy-into-another-chair-is-movement-evidence.law.test.ts`; the earlier F06 laws name this migration as their successor.
