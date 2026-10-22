# A Player's Own Sit Out Is Not Undone By A Horse Controller

## What Was Seen

Lightning pilot witness run 39771149895 (mode `financial_top_up_sitout`, live
engine `bae91fc9`) sent one normal Sit Out for pilot horse account 009
(HTTP 200, `SUCCESS`) and read the persisted pause from `table_seats`. It then
waited for the pool's hands to go quiet and hit its deadline at
`sitout_settlement`, because 009 kept being dealt a new Lightning hand roughly
every forty seconds.

Engine log, anchor table `94734f85`:

```
11:32:00.441Z Disconnect: PLAYER_SAT_OUT  player=0097309f
11:33:11.440Z Disconnect: PLAYER_SAT_BACK player=0097309f
11:33:11.440Z [SessionRotator] sat 2 horse(s) back in from a sit-out no break on record explains (a restart forgot it)
```

The database agrees. The hand formed at 11:31:59.5Z settled at 11:33:12.03Z,
and the next one formed at 11:33:12.27Z, a quarter second after the rotator
sat the seat back in. After that the seat read `is_sitting_out = false` and
`sit_out_at = null`.

## Root Cause

`HorseSessionRotator` assumes that any horse sitting out at a cash table with
no break in its memory is a break a restart forgot, and sits it back in. Pilot
horse accounts are also driven by an authenticated client, so the rotator
undid a Sit Out the account's own client had asked for. Nothing else sits a
horse back in. The Lightning matcher was not at fault: formation and legality
both refuse a sitting-out anchor through `fn_lightning_anchor_is_live_eligible`,
and they dealt 009 only after the flag had been cleared.

## Change

- `POST /sitout` (the account's authenticated client door, including the
  Lightning anchor route) now marks the Sit Out as requested by the client.
  The mark is set before the sit-out applies, so a mid-hand deferred Sit Out
  is covered too.
- `DisconnectEngine` keeps that mark as `sitOutByClient`. Only `sitBack` (the
  client's I'm Back) clears it. It travels in the presence park and the crash
  snapshot, so a restart does not turn the player's pause back into a
  "forgotten break". An older park without the field restores as before.
- `ServerTableEngine.isClientSitOut(userId)` answers the question.
  `HorseSessionRotator` asks it before both of its automatic sit-back-in
  paths, the forgotten-break restore and the end of its own short break, and
  leaves a client Sit Out standing. An answer that throws counts as the pause
  standing.

Ordinary horse behaviour does not change. Breaks the rotator starts itself
still end on time, and a strike-ladder or restored sit-out with no client
request is still sat back in once. The witness is unchanged.

## Verification

`server/src/services/aPlayersOwnSitOutIsNotUndoneByAHorseController.test.ts`
drives the real engine `sitOut`, the real `DisconnectEngine` and a real
rotator pass over a fake floor, replaying the observed sequence (a client Sit
Out deferred mid-hand, applied at the hand end, then a rotator pass with no
break on record). Against the original rotator, three of its seven cases
fail; with the fix, all seven pass. The handler expectations and the two
source pins on the rotator's sit-back calls are updated in this change.

Release: engine runtime. Ships at the next daily 04:00 Chicago engine release.
No database change.
