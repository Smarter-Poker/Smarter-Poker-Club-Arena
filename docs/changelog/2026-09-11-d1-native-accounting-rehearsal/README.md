# D1: the real bust determines the finish

The native PostgreSQL 17 rehearsal completed
`7aa16fa7-adf7-4fb9-81b9-b565d8e4af7d` with tankChamp 36th for 1.94 and the 23
intervening true-order finishers each moving up one place. It paid 39 finishers
204.40 and credited 11.60 rake to the actual union wallet. All 385 final positions
and all payout recipients/cents match an independent calculation. Repeating the
terminal door changes no observed financial/game state.

Three different values must remain distinct:

| Observation                                            | Place | Prize |
| ------------------------------------------------------ | ----: | ----: |
| Current captured display cache                         |    12 |  4.68 |
| Ordinary settlement using the invalid later generation |    13 |  4.37 |
| Authorized real-bust ruling                            |    36 |  1.94 |

The original candidate `266af3b0-7791-4681-8e49-752a62deeb45` names hand 8775892,
committed at **2026-09-09 22:35:09.777892 UTC**, and was incorrectly marked
`rebought`. Candidate `bea72c06-dde6-4d97-b3d5-dd003627a676` names hand 8803695
in the later repair-created seat generation and was marked `eliminated`.
Changing only the player's timestamp would fail: ordinary ranking deliberately
chooses the latest candidate whose state is `eliminated`.

## Reusable evidence boundary

Migration `20260911160603_tournament_knockout_invalidations.sql`, reserved with
`scripts/new-migration.mjs`, adds an `invalidated` terminal candidate state and
an operator-only immutable evidence table. The schema contains no incident UUIDs.
The exact one-event transaction is `D1_7aa16fa7_true_bust.sql` in this directory.

Evidence includes both complete candidate before-images, the player before-image
and the immutable financial core of both accepted-hand receipts. Post-commit
payloads are outside that financial-core projection; source rows are untouched.
An insertion validates actual matching succeeded settlement receipts and binds each
candidate seat identity and generation to the accepted request or zero-stack
seat-generation result. It refuses conflicting request identities, locks in
the established settlement/event/roster/generation order, requires a running
unpaid non-bounty event and an eliminated seatless player, and refuses evidence
of a purchased intervening re-entry. Ordinary roles, including service_role,
have no authority to insert into this table. A trigger admits only the recorded
state/resolution transitions and freezes both adjudicated candidate rows.
Deferred closure requires both transitions and the real player timestamp in the
same transaction, preserving every other player field. Nullable malformed pool
finalization or player chips fail closed. No wallet, prize, other player's chips, or money source changes
inside the ruling.

The current 15 database functions referencing knockout candidates and both
engine reader sites were inspected. Pending indexes and automatic state writers
require `pending`, `eliminated` or `rebought`; they do not select `invalidated`.
The latest-evidence helper deliberately still returns the invalidated generation,
so it blocks re-entry instead of silently authorizing an older one. The normal
ranking filter selects the restored original `eliminated` witness. No existing
financial-function body changes. Existing accepted-hand retention remains its
own policy; the immutable ruling retains the financial witness copies.

## Native proof

```sh
python3 scripts/ci/rehearse-d1-tournament-ruling.py
```

Run outside :50-:03 UTC. Optional `--pg-bin /path/to/postgresql17/bin` selects
local PG17 binaries. The runner accepts no database URL or credentials and makes
no network calls. It verifies the archive, starts a private socket-only cluster,
restores the scoped evidence, applies this schema locally, tests the guards,
runs the exact ruling and financial settlement, writes receipts and stops its
cluster. Readable test sources are under `scripts/ci/rehearsals/d1`; the entry
point checks that they match the sealed versions before execution.

The fixture contains 385 players, 462 candidate generations, 423 financial hand
commits and matching settlement receipts, 418 historical seats, 117 existing
ledger entries, 116 existing wallet receipts, 116 refund entitlements and all
116 real rake records. Player wallets are restored across their two stamped
clubs with the event club, union and union wallet. Three explicitly hypothetical
future hands finish the four remaining players through the real elimination
door. Those paid-range busts create no place obligation or payment. This is a
financial finish rehearsal, not a prediction of their future gameplay.

The actual monetary checks are 204.40 in payouts and club-member credits,
11.60 in union-rake credit, 216.00 in new ledger legs, zero remaining escrow,
zero live seats and zero pending wakes. Original ledger and refund entitlement
rows stay unchanged. Original wallet financial fields stay unchanged; native
terminal closure markers are added. Every captured candidate identity and
atomic financial receipt stays unchanged. Historical players keep their status,
chips and recording sequence; only tankChamp's elimination time is adjudicated.
No resequencing toggle or clawback is used.

Fourteen pre-ruling negative cases cover unaudited invalidation, ordinary-role
evidence insertion, orphan evidence, only one transition, false before-images
or commit receipts, mismatched seats or seat generations for either candidate,
nullable malformed pool or chips, and an unrelated player-field rewrite. Seven post-ruling refusal cases cover evidence update/delete/
truncate, revival of either candidate, candidate deletion and identity rewrite.
Real elimination replay and the latest-evidence barrier are checked before the
modeled finish. Every denied transaction leaves the observed tables unchanged.

The preexisting composition verifies 521 current function bodies and 293 trigger
definitions/states; the additional audited schema is separately sealed. Seven
historically disabled tournament guards remain disabled. This does not certify
later all-guard activation, migration 20260911110000, or the separate PKO event.

## Source and application boundary

Base source: `29b6ae08b20ca34b575d27492370d4cf5ad1bd67`; current scoped function,
trigger and event reads: 2026-09-11. Input manifest SHA256:
`23a805d6343cbb2906d9a6a4158a7d663a6b8d1865a2d43c2d589915fa26539c`.
Archive SHA256:
`3e4a46f2063eb583fb6ac94f7f1e4226fde967df7c29a5f2825fe05aa5391d19`.
Exact D1 ruling SHA256:
`ca34b31ce7e595a394b70d8ee53bb97636d9abab63f53c4ea960080c88a8ca31`.

No production migration, ruling or wake was applied. The sole production owner
must refresh current source/guard and event pins, apply the reviewed schema,
then execute this ruling outside :50-:03 before the reviewed R2 wake. If place
money has moved, this unpaid-event path refuses; preserve that payment and
reconcile the difference through D8. Do not run overlapping R2/fleet wakes.
