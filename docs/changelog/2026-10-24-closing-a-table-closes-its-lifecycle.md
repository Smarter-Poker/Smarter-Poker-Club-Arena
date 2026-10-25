# Closing a table closes its lifecycle (2026-10-24)

## What was wrong

`fn_close_managed_game('table', id)` - the door every managed close goes
through - closed a cash table with `SET status = 'closed', current_players = 0`
and never wrote `lifecycle`. Every other closer (`fn_cash_cluster_tick`, the
Diamond cash close, tournament cancel/complete and both satellite closeouts)
writes `status` and `lifecycle` together.

So a table closed through the door stayed `lifecycle = 'live'`. Its game
still counted it: `fn_cash_cluster_census`, `fn_cash_game_join` (table count
and existing-seat check), `fn_offer_open_seat` and `idx_tables_cluster_open`
all select `lifecycle <> 'closed'`, and `fn_closed_cluster_main_releases_index`
only releases a main table's `main_index` once lifecycle is `closed`.

Measured read-only at 23:00Z: 30 tables in that state. Every one was a game's
main table, every game was switched off, and none had an open seat. 21 still
held their main_index. By club:

| Club                         | Tables | Settled? |
| ---------------------------- | ------ | -------- |
| Lightning Internal Pilot     | 9      | yes      |
| Club Savage                  | 9      | yes      |
| Crest Cert Template 095896f4 | 3      | yes      |
| Crest Cert Template c4059717 | 9      | no       |

The last club is retired. `fn_guard_retired_club_mutation` makes a retired
club's gameplay records read-only, so those 9 rows are left alone. Nothing
can run in that club.

Found while closing the Lightning pilot games (owner order: every Lightning
game runs from Midway Union only).

## Fix

`20261024230029_closing_a_table_closes_its_lifecycle`:

- **The door.** It is restated with `lifecycle = 'closed'` added to that one
  UPDATE. The body is production's current body byte for byte (prosrc md5
  `57ed378cd27c0031cb0cb81e47029089`). That body is the 20260909192240 text
  with the 20260910035435 lane rewrite applied, which had only ever been done
  dynamically. The repo's latest literal definition had lagged production
  since 2026-09-10, so this file is now the literal source again. ACL is
  restated unchanged: service_role only.
- **The settlement.** The 21 tables in clubs that are not retired are set to
  `lifecycle = 'closed'` in the same transaction. Each one is status
  `closed`, in a switched-off game, with no open seat. No seat, chip, wallet
  or game row is touched.
- **The probe.** A rolled-back probe returned fixed=21, left=0 and
  main_index_left=0.

## Pinned by

- `tests/closing-a-table-closes-its-lifecycle.law.test.ts`
- `tests/unit/tableManagementPhase1Recertification.test.ts`. Its
  composed-close pin moves to this file, in the same commit.
