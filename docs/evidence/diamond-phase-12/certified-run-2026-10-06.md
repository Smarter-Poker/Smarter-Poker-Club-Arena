# Diamond Phase 12 line 5: the certified run (2026-10-06)

Run by Dan on the published build, https://smarter.poker/hub/club-arena/,
signed in as the platform service identity `daniel@smarter.poker`
(`2d1cd6c3-5700-4af9-a271-d4863fdab20d`), between 02:12 and 02:28 UTC.
Published revisions at the time: World Hub `5b396357` (and later), Club Arena
main after #6226. Ledger rows read back from production by Claude the same
night.

| Leg      | What happened                                                              | Read back from production                                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buy-in   | NLH 1/2 (`22a9bc88-2874-4796-bccc-faa6216de5fd`), 400 Diamonds             | `diamond_transactions` `arena_deposit` -400 at 02:12:05; `poker_diamond_custody` row `f5d31538` purpose `cash_seat`, seat `02961345`                                                                |
| Play     | Seated, posted the big blind                                               | **Not proved.** The table was empty, so no hand was dealt; no `hand_histories` row in the arena since                                                                                               |
| Leave    | Left the table                                                             | `arena_withdraw` +400 at 02:13:05; custody `released`, balance 0; no open `table_seats` row for the account                                                                                         |
| Transfer | 10 Diamonds to an accepted friend, horse account `prairiegal` (`00d92d99`) | `diamond_wallet_transfers` `9e00ec7b`: sender journal `613de06f` (-10, `diamond_gift_sent`), recipient journal `759966d2` (+10, `diamond_gift_received`, balance after 9,489, equal to the profile) |

The service identity's journal sums to its balance exactly (3,029 = 3,029).
The custody opened and closed for the same 400, and nothing is left reserved.

## What this does and does not certify

Buy-in, leave and transfer pass end to end on the published build, through
the platform's own doors, with every leg on both sides of the ledger.

Play is not certified: no hand was dealt. Every arena cash table was empty
when the run was made and still had no seated player when this was read
(0 open seats across the arena's 17 cash tables). Line 5 stays open until a
Diamond cash hand is dealt and settled on the published build.

## Switches

`ca_arena_settings`: `cash_games_enabled = true` (opened by Dan after the
run), `tournaments_enabled = true` (already open). Read back 2026-10-06.
