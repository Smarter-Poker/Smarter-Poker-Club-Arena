# The Supply Meter Counts A Hand In Transit (2026-10-16)

Migration `20261016172614_the_supply_meter_counts_a_hand_in_transit.sql`.

## What was wrong

The hourly chip supply meter (`fn_ca_supply_snapshot`) read a few unexplained
chips about twice a day: -5.00 then +5.00 (10-15 06:05, 07:05), -6.20, +0.70,
+1.90, +3.60, -5.40 then +5.50 (10-16 08:05, 09:05), -0.10 (16:05) and -1.93
(17:05). `20261016042936` stopped those paging the owner's phone below 100
chips; it did not find the cause.

A settled cash hand is written in two transactions. The accepted-hand commit
moves the seats by inflow - rake - bbj (`hand_atomic_commits`, obligations
recorded, `post_commit_completed_at` NULL). The post-commit obligations post
the rake to the union wallet and the drop to the BBJ pool, write their
`chip_ledger` legs, resolve any add-on and stamp the hand complete in the next
transaction, a few hundred milliseconds later. A reading in that gap counted
the seats after they paid and the receivers before they were paid, so it was
short by the in-flight amount and the next reading long by it. The legs are
internal, so the late-leg re-read of `20261002164500` never saw them.

Measured read-only on production, both to the cent:

| Reading             | Unexplained | In flight at the cut                                                                                      |
| ------------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| 16:05:00.286 (1182) | -0.10       | hand d6588e74: rake 0.09 + drop 0.01                                                                      |
| 17:05:00.320 (1183) | -1.93       | hands 8eb28ce6 (1.65 + 0.25) and 41dbd983 (0.13) = -2.03, plus the 0.10 that 1182 missed arriving = -1.93 |

`fn_ca_account_balance` already counted this quantity on the felt (2026-10-11
and 10-12); the supply meter it names as its definition never got the line.

## The fix

The meter reads `rake + bbj - inflow` of every hand whose obligations have not
posted, with the same predicate and partial index as `fn_ca_account_balance`
(7.8 ms on production), excluding tournament and Diamond tables exactly as the
felt does, in the same one-statement snapshot. It is stored in a new column,
`ca_supply_snapshots.posthand_transit`, and added to `total`. The basis moves
to `posthand-transit-v6`, so the first reading after install has no
unexplained figure and is never compared with v5. No money, no other store, no
threshold and no escalation moves. The redefinition is declared to the guard
watch in the same transaction.

## Proof

`scripts/ci/test-supply-meter-hand-in-transit.py` (native PostgreSQL, 31
checks; workflow `.github/workflows/supply-meter-hand-in-transit.yml`) loads
the exact production definition (md5 `c9fa91ce...`), reproduces the defect
(-1.90 then +1.90 for an in-flight rake and drop, +9.50 then -9.50 for an
add-on in flight), applies the migration, and proves every phase of the same
hands reads 0, tournament and Diamond hands stay off the chip meter, the
postimage equals the one derived read-only on production (`de5f2ec2...`),
owner, security, settings and grants are kept, the guard redefinition is
declared, and a second run is refused.
