# Horses answer players, and never repeat a line across the tables a player sees (2026-10-24)

Dan, after the repeat fix: "GO AHEAD AND FULLY BUILD, FIX AND ENHANCE ALL OF
THESE AND MAKE SURE THEY ARE FULLY WIRED IN AND TESTED BEFORE CLAIMING
SUCCESS." Three items, built in this order.

## 1. No repeats across every table a player can see

The never-repeat rule (`2026-10-24-a-table-never-hears-the-same-horse-line-twice.md`)
was per table. A player with two tables open reads both chats.

- `HorseTableTalk.viewersOf`: the people who can read a table's chat are its
  seated humans plus every user with it open in this process
  (`TableStateHub.userIdsAt`). A horse has no browser and is never a reader
  (identification under CLAUDE.md 10.5, written without a negated `isHorse`
  so `theHorseSaysNothingItWasNotTold.law.test.ts` keeps holding).
- `otherTablesTheyCanSee`: their other tables, from open sockets here
  (`TableStateHub.tablesWatchedBy`) and from every active `table_seats` row
  (`left_at IS NULL`), so a table on another engine process counts.
- `readTalkHistory` reads the ledger for those tables over the same 24 h
  window (`viewerRows`); `heardPhrases` and the claim check include them.
- A seat read that fills `VIEWER_SEATS_LIMIT`, or more than `VIEWER_TABLES_MAX`
  other tables, is "could not tell": silence (CLAUDE.md 10.86). A table nobody
  human can read makes no seat read at all.

## 2. Horses answer when a player talks to them

Production chat (read 2026-10-24) held "Nice Hand", "Unlucky", "FUCKING LUCK
BOX", "NICE BALUE BET CAPTAIN", "FAT FINGERED THAT SMH", "YOU GUYS PLAY HERE
EVERY NIGHT?! LOL", "Hey Ingrid". The engine never saw any of them: browsers
write `table_chat` directly.

- `HorseChatListener.ts`: one Realtime `postgres_changes` channel per engine
  process (`engine:table-chat-replies`, INSERT on `table_chat`,
  `message_type=eq.player`), the BombRequestBus shape. `table_chat` was
  already in the `supabase_realtime` publication for the browsers' feed
  (about 4,700 rows a day), so this adds a subscriber, not a WAL cost. Each
  cash engine registers a live-state provider at start and on its throttled
  refresh (which also re-opens a channel a terminal status released), and
  unregisters in `stop()`, owner-safe so a superseded instance cannot remove
  its successor. Best-effort: no catch-up, poll or retry loop (CLAUDE.md 10.12).
- `horseChatIntent.ts`: a pure classifier, six intents (thanks, ribbed,
  sympathy, humble/misclick, hello, "do you play here every night"), plus
  `addressedHorse` for a seated horse named in the line.
- **Never answered:** any line asking or claiming whether someone is real, a
  person, a bot, automated or AI, or calling the game rigged, cheating or
  collusion. No horse reply of any kind; the check runs first and wins over
  any other intent in the line. A horse does not claim to be a person.
- `HorseTableTalk.replyToPlayer`: only a person who can see the table is
  answered (seated, or watching here); a horse never answers a horse; a row
  older than `REPLY_MAX_AGE_MS` is not answered. Who answers: a named horse
  (`REPLY_ADDRESSED_PCT`), else "nh" / "lucky" to the last hand's winning
  horse, "unlucky" to its showdown-losing horse, "my bad / misclick" to a
  horse that lost to the speaker or any horse, "hi" / "every night?" to any
  horse. All by hash, never a roll.
- Replies are six new talk events (`reply_*`) with 9 lines per voice, so they
  inherit the gate, voices, styling, the one door, never-repeat (table and
  cross-table), the hourly cap, mutes and the typing pause. The claim key is
  `replyKey(chat row id)`, negative so it never meets a real hand number, which
  makes "one horse answers one remark" true across processes with the existing
  UNIQUE (table_id, hand_number). No migration.
- Replies skip the hand cadence (they answer a person, not a hand) but a table
  hears at most `REPLIES_PER_TABLE_WINDOW` per `REPLY_WINDOW_MS`. The hand
  cadence now reads hand rows only (`hand_number > 0`), so a reply row can
  never hide a recent hand line.

## 3. Talk rates

The rare hand events were held at 20/25/20 only because each had one line per
voice. Now 26/28/25 (`big_pot_won` / `showdown_loss` / `big_hand_shown`).
`HORSE_LINES_PER_HOUR` (6) and the hands-between rules are unchanged, so no
horse talks more per hour.

## 4. A sentence takes as long as a person needs to type it

Dan, mid-build: "AND THEY CAN'T FIRE OFF FULL SENTENCES RIGHT AFTER A HAND IS
OVER". Every typed line waited a flat 1.4 to 5.2 s, so "46 bb on the river,
somebody wanted to see my cards" plus two emoji could land 1.4 s after the pot.

`horsePacing.typingBeatMs` now builds the wait from the exact styled text that
will be written: 1.5 to 4.5 s to take in the result, plus, for a reply, the
time to read the remark (20 chars/s, at most 4 s), plus every character at the
horse's own habitual speed (2.6 to 5.4 chars/s, a fixed habit per horse, with
a per-line wobble), plus 0.8 to 1.8 s to open the emoji picker and 0.3 s per
emoji. Capped at 32 s (14 s for a line said while shoving, typed a little
faster). The screenshot line can no longer land in under 10 s for any horse;
"gg" still lands in 1.5 to 6 s. Throws keep their tap timing.

## Verified

- Server: 375 files / 7,236 tests pass across `src/services`, `src/transport`
  and the engine settlement/dealing/base suites; `tsc --noEmit` clean.
- Root: every test reading a changed file (39 files, 1,065 tests) passes; the
  full `tests/` suite run recorded in the PR.
- New: `horseChatIntent.test.ts` (48, real production lines),
  `HorseChatListener.test.ts` (routing, owner-safe unregister, channel
  lifecycle, engine wiring by source), `TableStateHub.viewers.test.ts`, reply,
  cross-table and end-to-end tests in `HorseTableTalk.test.ts` (a Realtime row
  through the real reply path to the ledger claim and chat row).
- Pacing: every pool line, filled, waits at least its characters at the
  fastest typing speed plus noticing; `say()` is proven to wait on the exact
  written line (and, for a reply, the remark's length).
- Repo-wide source-scanning laws: 104 root files, 3,021 tests pass.
- Mutation-checked: removing the never-answer guard, or the hand-rows-only
  cadence filter, turns tests red.

## Live proof after the 04:00 engine reset

- `horse_table_talk_ledger` rows with `event LIKE 'reply_%'` appear for human
  remarks; none for lines matching the never-answer list.
- The 24 h repeat query, per table and per viewer, finds no repeats among
  lines said after activation.
