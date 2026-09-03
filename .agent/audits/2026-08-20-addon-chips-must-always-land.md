# Add-ons must always award their exact chips — 2026-08-20

Dan, binding: _"Fix the add-on bug. It must ALWAYS award the specific amount of
chips added to the stack count when purchased. Don't worry about fixing the
$25.00 as long as the bug is fixed and we don't have that issue anymore."_

The refund of the ~91 players charged 25.00 is explicitly waived. What follows
is the guarantee that it cannot recur.

---

## What was wrong

Four defects sat between paying for chips and holding them. Each one alone
loses the chips.

### 1. Charged with no seat to put the chips in

`process_tournament_rebuy` updated the player's seat behind `IF FOUND`, with no
`ELSE`. A player with no live seat — routine during table consolidation, when
the old seat closes before the new one exists — was charged, had
`tournament_players.chips` incremented, and then had that grant erased, because
the elimination sweep syncs chips **from** `table_seats`.

Measured on the first add-on window ever to run (Prime Time Main Event,
2026-08-20 19:14): **103 add-ons charged 2,575.00; 1,030,000 chips owed;
~121,000 delivered; 908,552 chips never reached a seat** — roughly 91 players
paid and received nothing.

Fixed in migration `20260821s`: the seat is checked **first**, before any money
moves. Either the player is charged and seated with the chips, or the
transaction raises and neither happens. Re-entry is exempt — it deliberately
re-seats an eliminated player.

### 2. Refusing correctly, but only offering once

Fixing (1) closes the money hole but, alone, _costs those players their add-on_:
the offer was made exactly once, when the window opened, so a player who
happened to be mid-table-move at that instant was skipped forever.

Fixed in Club Arena `b75aecc6b`: the offer repeats for as long as the window is
open (`addOnPeriodTriggered && !prizePoolFinalized`), throttled to 20s against
the 5s sweep. Re-offering is safe by construction — the wallet idempotency key
`tourney:{id}:addon:{user}` and the `Add-on already taken` check each prevent a
second purchase.

### 3. The right amount, into the wrong seat

The seat lookup was a bare `LIMIT 1` with **no `ORDER BY`**, and five players in
production were holding **two live seats** in the same tournament. The planner
was free to return the stale row, so the chips could land on a seat nobody is
playing — the same hole as (1), through a different door. Not a rounding
matter: in Union Grand Championship the stale seat held **15,000** against a
real stack of **2,728,737**.

Origin of the duplicates: the table-move rollback re-activated the source seat
whenever the destination write returned an error — including when that write had
actually **committed** and only the client saw a failure. The signature is
unmistakable: both rows carry an identical stack (Late Night Grind 1113/1113,
796/796, 1950/1950).

Fixed in `20260821u` (newest live seat on a still-open table, deterministically)
and `b75aecc6b` (re-read the destination before restoring the source; treat a
committed-but-errored write as a completed move). Existing rows cleaned in
`20260821v`.

### 4. Every restart built a second set of tables

`createTablesAndSeatPlayers` inserted a fresh set of tables on every call and
seated the whole field into them, ignoring tables the tournament already had.
`start()` calls it **before** the "only REGISTERING → RUNNING" status guard, so
calling `start()` on an already-RUNNING tournament built a complete second set
and re-seated everybody, leaving the originals live.

Found live while verifying the above: **"5 Chip Turbo SNG 6-Max NLH" held three
tables all named "Table 1"** — the real one from 20:20:53 (22 hands, dead after
the restart) plus duplicates at 20:33:58 and 20:34:04, each with six live seats.
Six players were seated twice at tables **dealing hands concurrently with
diverging stacks**, so the field held 18,000 chips against 9,000 issued.
`fn_tournament_chip_conservation_check` flagged it at exactly 2x.

Fixed in `77581ddcd`: the function is now idempotent — it adopts existing
tables, creates only the shortfall, never re-seats a player who already holds a
live seat, and takes the lowest free seat number so a new seat cannot collide.
Abandoned copies closed in `close_abandoned_duplicate_tournament_tables`.

---

## The guarantee, and how it was proved

Atomicity says the charge and the grant travel together. It says nothing about
the **amount**. `20260821u` asserts the amount, in the same transaction as the
charge: after the seat update the new stack must equal the old stack plus the
configured chips exactly, or the whole purchase — money included — rolls back.

Proved in production, both directions, in rolled-back transactions:

| Probe                                             | Result                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Seated add-on, Prime Time Main Event              | stack `10,000.00 → 20,000.00`, delta **exactly 10,000** against a configured `addon_chips` of 10,000; one wallet row                          |
| Real function body, grant shorted by **one chip** | raises `Chip grant did not land: addon expected stack 20000.00 (10000.00 + 10000), seat ... holds 19999.00`; wallet rows **unchanged, 1 → 1** |
| Seatless add-on (from `20260821s`)                | refused; `charged_before=1 charged_after=1`                                                                                                   |

The assertion is load-bearing, not decorative — the mutation test is the proof.

---

## Guards

`TournamentFixes.guard.test.ts` now carries 27 guards; `npm test` runs inside
`auto-deploy-hetzner.yml` **before** it builds or ships, so a silent revert
fails the deploy instead of vanishing. Every new guard was mutation-tested —
deleting the repeat offer, the throttle, the seated filter, the destination
re-check, its telemetry, the shortfall bound, the re-seat filter, or the
free-seat scan each fails the suite.

Two guards passed their first mutation and were rewritten:

- the destination re-check guard keyed on a **variable name**, so renaming it
  alone passed. Now structural: the window between the error branch and the
  restore must read `move.toTableId` / `move.toSeat` and exit early.
- the re-seat guard sliced to **end of file**, so a `players.filter(`
  elsewhere satisfied it. Now anchored to the `table_seats` insert itself,
  which must write `toSeat[i].user_id` and must not write `players[i].user_id`.

A guard that does not fail on its defect is worse than no guard.

---

## Verified after deploy

Engine `77581ddcd`, deployed 20:42:19, completed/success. The deploy restarts
the engine — precisely the condition that produced three "Table 1"s an hour
earlier. After it:

- duplicate live seats: **0**
- tournaments with same-named live tables: **0**
- tournament tables created since restart: **1**, a genuinely new Spin
  (`1 Chip Spin NLH (3x)`, started 20:44:03) with exactly one table
- 11 running tournaments, 204 hands in 3 minutes
- add-on charges vs flags vs idempotency keys: **103 / 103 / 103**
- add-on rake rows: **0** — add-ons are not raked, per Dan's rule

---

## Shipped

| Where      | Ref                                                                                  |
| ---------- | ------------------------------------------------------------------------------------ |
| Club Arena | `b75aecc6b` repeat offer + move rollback + guards                                    |
| Club Arena | `77581ddcd` idempotent seating + guards                                              |
| World Hub  | `432532a919` migrations `20260821u`, `20260821v`                                     |
| Supabase   | `20260821s`, `20260821u`, `20260821v`, `close_abandoned_duplicate_tournament_tables` |

`20260821u` file body md5 `a718522dbecd364fce7cb55c9135c213` matches production
`pg_proc.prosrc` exactly.

---

## Open, not addressed here

- **Chip conservation drift** on two large events — Union Grand Championship
  +10,655 on 2,940,000 (0.36%) and Evening Mystery Bounty +1,874 on 300,000
  (0.62%). Pre-existing and documented in `20260821q`: the tournaments carrying
  it are the ones holding **fractional** seat stacks, because the hand engine
  splits pots to two decimals like cash money. Cause not established; the check
  reports rather than corrects, deliberately. Worth noting the Union Grand
  figure has grown from the ~261 recorded earlier, so it is accruing, not
  static.
- The World Hub working tree on Dan's Mac is **44 commits behind** with ~60
  modified files, and the Club Arena tree was behind too (missing
  `payoutMath.ts` entirely). This is the exact condition that silently reverted
  three fixes in one day: an agent copies a whole file from a stale tree, the
  build is green, the fix is gone. The four tournament files were mirrored to
  the shipped content; the rest of both trees still needs a deliberate
  reconcile by their owners.
