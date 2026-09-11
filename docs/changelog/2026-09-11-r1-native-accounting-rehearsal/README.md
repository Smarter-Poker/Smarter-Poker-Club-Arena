# R1 native accounting rehearsal

The exact preserved `R1_a5aa6984_record_river222_bust.sql` passed against current
event data and the real PostgreSQL 17 financial composition. The native terminal
door completed `a5aa6984-6c1c-4b59-aeb7-9e7878853bdd`, paid ten finishers 99.30
in independently verified true bust order, and credited 2.70 of rake to the
actual union wallet. River222 finished 100th. The 1.00 undelivered rebuy charge
remains D8 debt; this procedure issues no refund or new entry entitlement.

```sh
python3 scripts/ci/rehearse-r1-tournament-ruling.py
```

Run outside :50-:03 UTC, as required by the preserved script. The optional
`--pg-bin /path/to/postgresql17/bin` selects local binaries. The runner verifies
its archive and inputs, starts a private socket-only cluster, executes the exact
ruling and real terminal settlement, writes receipts, and stops its cluster.
It accepts no production destination or credentials and uses no network.

Current data: 100 players, 121 knockout generations, 87 financial hand commits
and matching settlement receipts, 102 historical seats, 28 ledger entries,
27 wallet receipts, 27 refund entitlements and 27 real rake records. All 100
stamped player club wallets are included across their two clubs, plus the event
club, its union and real rake wallet. Profile names are synthetic fixture
identity scaffolding; financial rows and IDs are captured evidence.

Proof checks all 100 final positions, all ten payout recipients and amounts,
99.30 club-member credits, 2.70 union-rake credit, and 102.00 of new balanced
ledger legs. Original ledger and entitlement records stay unchanged; original
wallet receipt financial fields stay unchanged, with only native terminal
closure markers added. Escrow balances, live seats and pending wakes reach zero.
The exact terminal replay leaves 17 financial/game-state tables unchanged.
The script's earlier restricted-window run was refused with no state change.

The composition verifies 521 function bodies and 293 trigger definitions/states
from the bounded live reads. All seven existing disabled tournament guards
remain disabled. This proof does not certify later guard activation or the
unrelated PKO event. Fixture restoration alone uses transaction-local replica
mode; every actual ruling and financial call runs with normal triggers.

Source base is `29b6ae08b20ca34b575d27492370d4cf5ad1bd67`; current function/event
readbacks were captured 2026-09-11. The original script SHA256 is
`b0c902d8e766d59dbb8a2d315285cf20c71f842163e4a277aa58838ba15d6811`.
Archive SHA256 is
`cbb11ac8dbb1ded847431cc9baface447d37b078a065ea48b91a6cd99c2f7704`.
Input manifest SHA256 is
`8104de5856d2d18f29e8dc69b137759145c354fd31931989ae11c0b8d88d5e06`.

No production write or wake was performed. Before eventual application, the sole
production owner must refresh the scoped state/source/guard pins, reconcile any
change, and obey the current :50-:03 restriction. R1 includes its own wake;
exclude that wake from any subsequent fleet operation.
