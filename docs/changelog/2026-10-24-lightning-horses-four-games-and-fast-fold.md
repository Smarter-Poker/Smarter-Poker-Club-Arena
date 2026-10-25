# Lightning horses: four games like a desktop, and the fast fold they were already making (2026-10-24)

Owner rulings (Dan, 2026-10-24, verbatim):

1. "SEATING SHOULD BE DONE ACCORDINGLY TO HOW IT WAS ALWAYS DONE. 4 GAMES MAX."
2. "YES, HORSES SHOULD FOLD RIGHT AWAY IF THEY WERE ALREADY FOLDING."

## What was measured

- 22 horses sat in 3 or 4 Lightning pools (`cash_games.cluster_mode = 'lightning'`)
  while the matcher held them `MULTI_TABLE_LIMIT`. Their held time was 31% of
  all recorded Lightning waiting (p90 48 s in 3 pools, 174 s in 4).
- Live `fn_lightning_config(...)->'multi_table_limit'` is
  `{"desktop":4,"tablet":3,"mobile":2}`.
- Open pool sessions per horse right now: 163 in 1 pool, 64 in 2, 22 in 3,
  3 in 4, none in more than 4.
- Horses never used the Lightning fast fold. They folded only on their own
  turn (UTG p50 6.3 s after the deal, the button 15.6 s).

## Ruling 1: the cause, and the fix

`fn_lightning_player_legality` (live md5 `12f205a7d67fa3662ec3e88dcad1f506`)
reads each player's device class from `p_player_platforms` and treats a
missing class as the narrowest, mobile (limit 2). That map is built by
`LightningPresence.snapshot` from the `platform` field of presence reports,
and only a Lightning room whose browser socket said `?p=` ever filled it
(`LightningRegistry.connect` / `presenceReports`). A horse has no browser, so
no report ever named a class for it, and every horse was held to the mobile
limit of 2 live Lightning hands while the fleet seats it in up to four games.

A horse's input device is the engine (CLAUDE.md 10.5: it heartbeats the seat
and HorseLogic chooses the actions). The engine now says what a browser's
`?p=` says: `ServerTableEngineBase.lightningPresenceReport` adds
`platform: ENGINE_INPUT_DEVICE_PLATFORM` (`'desktop'`) for a horse seat. A
horse is therefore held to exactly the desktop limit, 4, never more. A human's
class still comes only from their own client, a real client on a horse account
still narrows it (the narrowest report wins), and the human limits are
unchanged.

The seating source already stops at four games: `MAX_TABLES_PER_HORSE = 4`
and `CONCURRENT_GAME_LIMIT = 4` in the fleet, and the database's
`fn_enforce_four_table_limit` on every `table_seats` insert (a Lightning
anchor is a cash seat). With at most four pools a horse has at most three
other live Lightning hands, so the desktop limit of four never holds it: it
plays every game it is seated in. No migration is needed; the SQL is
unchanged.

## Ruling 2: "already folding", defined and enforced

A horse is ALREADY FOLDING on a street when, at its FIRST priced look at that
street (the first moment the fast fold is open to it with chips owed: the
deal preflop, the first bet it faces later; or its own turn if the action
reaches it first), its own policy, asked through the same live decision lane
with its own style and mods, answers fold, and:

1. it owes chips and its menu has no check. A free check is never fast
   folded (the unraised big blind, any seat checked to);
2. the answer is the policy's own, not the liveness fallback of a failed
   worker or a brain exception;
3. it is the street's first priced look. A horse whose first answer was
   anything else waits for its turn and decides afresh on everything that
   happened since, on its ordinary clock, and that fold is an ordinary one.

Such a horse folds at once, with no think time, through the same door a
person's Lightning Fold uses: `LightningHandHost.handlePlayerAction` with
`fast_fold` and the hand's `lightning-hand:<id>` context, then `requestFold`
(`foldAvailable`, the operator's fast-fold switch, `performImmediateFold` off
the turn or the turn fold on it). The record says `horse_policy` (the
horse's own decision, as every horse action does) and the fold type is
`fast`, so settlement results, `fn_lightning_fast_fold`, hand history and
stats see exactly what they see for a person's fast fold. A fold commits no
plan effects; the decision's execution witness settles against the
controller record. An early look that does not fold is retired unexecuted.

What is NOT claimed: that a sampled fold would stay a fold under every
continuation. HorseLogic is stochastic and deliberately not monotone (the
maniac call-down turns folds into calls against a seat read as a maniac;
the VPIP floor call-down calls small raises on a floored table, and cannot
fire in Lightning because its snapshot carries no `vpipFloor`). What is
proven is the human's own contract: the fold is the player's decision at the
moment the button is open, it is final, and it is never a free check.

The early look's menu comes from a new read-only option,
`HandController.getAuthoritativeActionState(userId, { asIfToAct: true })`:
the menu and price the seat would hold if the action reached it with the
table as it stands. `performAction` still demands the real turn.
`performImmediateFold` takes the record's origin, so a horse's early fold is
labelled `horse_policy` and a person's stays `player`.

## Files

- `server/src/lightning/LightningPresence.ts`: `ENGINE_INPUT_DEVICE_PLATFORM`.
- `server/src/engine/ServerTableEngineBase.ts`: the horse's device class in
  the anchor presence report.
- `server/src/lightning/LightningHorse.ts`: the early-look snapshot and
  `lightningHorseIsAlreadyFolding`.
- `server/src/lightning/LightningHandHost.ts`: early looks, the first-look
  turn fold, and the door's internal origin.
- `server/src/engine/HandController.ts`: `asIfToAct`, and the early fold's
  origin.
- Laws: `server/src/lightning/AHorsePlaysFourLightningGamesLikeADesktop.law.test.ts`,
  `server/src/lightning/AHorseThatIsAlreadyFoldingFoldsRightAway.law.test.ts`.

## Delivery

Every change is engine code: it reaches production at the daily 04:00
America/Chicago engine release. No client or database change.
