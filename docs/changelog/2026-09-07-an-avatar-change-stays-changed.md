# 2026-09-07 - An avatar change stays changed

Dan, verbatim: "WHEN A USER CHANGES THEIR AVATAR, IT BOUNCES BACK AND FORTH
FROM THEIR OLD AVATAR TO THE NEW ONE. IT NEEDS TO CHANGE AND STAY ACROSS ALL
GAMES AND TABLES REGARDLESS OF DEVICE AS WELL."

## What was actually happening

The obvious suspect was two columns. `profiles` carries both `avatar_url` (the
social media photo) and `arena_avatar_url` (the Club Arena library art), and
if the engine read one while the client's live profile sync read the other,
every engine broadcast would paint one picture and every realtime event the
other. Checked, and it was not that: the engine roster load
(`server/src/services/supabase/tables.ts`, `avatar_url:arena_avatar_url`), the
client sync (`src/hooks/useSeatedProfileSync.ts`, `row.arena_avatar_url`) and
both writers (`AvatarService.setUserAvatar` here, `setPresetAvatar` /
`setActiveAvatar` in the World Hub) all name `arena_avatar_url`. Production
agreed: Dan's own row after today's change at 22:24 UTC held
`arena_avatar_url = /avatars/free/pirate.webp` with `avatar_url` null, and no
trigger on `profiles` touches either column (`fn_guard_horse_avatar` only
protects a horse's photo from a library path; nothing writes the arena column
back).

The bounce was two readers of the SAME column sampling it at different times:

- The engine reads the seated roster once, at the top of each hand
  (`loadSeatedPlayers` in `ServerTableEngineDealing.ts`), copies name, avatar,
  frame and aura onto the hand's players (`hcPlayers`, `avatar_url:
p.avatar_url`), and republishes those on EVERY broadcast for the rest of the
  hand - each action, each street, each timer tick.
- `useSeatedProfileSync` delivers the new value the moment the row changes:
  the picker's BroadcastChannel event, the postgres_changes UPDATE, and a
  reconcile read whenever its channel comes live.

`TablePage` merged both into the same `tableState.players[i].avatar`, last
writer wins. So the picker painted the new face, the next engine broadcast
painted the deal-time copy back, the realtime echo painted the new one, the
next action painted the old one, and so on until the next deal, when the
engine re-read `profiles` and the two finally agreed. Every viewer at the table
saw it, on every device, because every viewer runs both readers. "Regardless
of device" was never a cache problem - `cachedIdentity.ts` and the header
store only pre-warm and are overwritten by the database read - it was this
same race, seen from a second phone.

## The rule

The engine is authoritative for the HAND: stacks, cards, status, seats, turn.
The database is authoritative for IDENTITY, and the engine's copy of identity
is a cache taken at deal time. A profile change delivered by the database is
therefore at least as new as anything the engine holds, and an engine
broadcast may not repaint over it.

The engine wins again the moment it proves it has re-read the row, which it
does by publishing an identity DIFFERENT from the one it was publishing when
the override was taken. Nothing but a `profiles` re-read moves those three
fields, and a re-read is by definition newer than the override - so the
override is dropped and the engine's value adopted, whatever it is. That last
clause is what keeps this a resolution rule and not a device-local cache: a
change this phone slept through is still corrected by the engine one hand
later, exactly as before.

`src/lib/seatIdentityOverrides.ts` is that rule, as a pure module with no
persistence. `TablePage` runs the mapped engine roster through
`apply()` before the card/status merge, and `handleSeatedProfileChange`
records each delivery through `record()`. Nothing else about the snapshot
merge changed.

## One column, written down once

The column half of the story was correct by coincidence - sixty-odd call sites
each spelling the alias by hand. It is now a rule with two copies that a test
imports and compares:

- `src/lib/tableAvatar.ts` - `TABLE_AVATAR_COLUMN`, `TABLE_AVATAR_SELECT`,
  `tableAvatarFromProfileRow()`; the sync reads through it.
- `server/src/services/supabase/tableAvatar.ts` - the engine mirror, plus
  `SEATED_PROFILE_SELECT`, which `loadSeatedPlayers` now selects through.

There is no precedence between the two columns because there is no choice: a
seat shows `arena_avatar_url` and nothing else, human or horse (CLAUDE.md
10.5 - nothing here branches on `is_horse`; a horse's avatar takes exactly
the path a human's does, through the same roster read and the same sync).

## Anonymous tables

`seatIdentity()` in the engine scrubs every seat's name, avatar and cosmetics
at an anonymous table. The profile sync already painted the real face over
that scrub between broadcasts (a pre-existing leak, hidden by the very bounce
this fixes), and an override that outlives the broadcast would have made it
permanent. So the engine now publishes `is_anonymous` beside `max_seats` on
all three payloads, `mapEngineSnapshot` maps it to `isAnonymous`, and at an
anonymous table the page subscribes to nobody and bypasses the override. An
engine older than the field maps to `false`, which is today's behaviour.

## Regardless of device

When the delivered change is the hero's own (made on another device, or in
another tab), `heroAvatarUrl` and the first-paint cache follow it, so the
buy-in modal, the hero hub and the pre-deal placeholder seat agree with the
seat. The cache is refreshed FROM the database value, never the reverse.

## Tests

- `tests/unit/seatIdentityOverrides.test.ts` (12): the bounce replayed
  broadcast by broadcast; the engine's re-read retiring the override; a
  re-read that disagrees being adopted; two changes in one hand; echoes;
  pre-first-frame delivery; cosmetics with null-means-removed; departure;
  clear.
- `tests/the-felt-reads-one-avatar-column.law.test.ts` (6, registered in
  `docs/laws.d/`): both copies of the rule identical, the roster read and the
  sync reading through them, the page wiring, the anonymity field on every
  payload.
- `tests/unit/mapEngineSnapshotCosmetics.test.ts`: `isAnonymous` mapping.
- `tests/unit/arenaAvatarSeparation.test.ts`: its engine pin now follows the
  projection into the mirror file.

`npx tsc --noEmit` clean for client and server.

## Not changed

The engine still re-reads identity only at the top of a hand. Making it react
mid-hand would mean either a realtime subscription per table on a one-core
process or a new engine endpoint for a cosmetic; the client-side resolution
above converges every viewer immediately and the engine one hand later, which
is the same convergence with none of that load.
