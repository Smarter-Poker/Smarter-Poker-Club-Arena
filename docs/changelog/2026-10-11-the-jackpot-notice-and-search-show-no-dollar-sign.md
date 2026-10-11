# The Jackpot Notice And Search Show No Dollar Sign

**Date:** 2026-10-11

Dan, 2026-10-09 23:44 CT: the dollar sign is forbidden anywhere in the Club Arena; "it just needs to say 100 Chip Guarantee".

PR #6603 and PR #6623 swept the client and engine copy, and migration 20261010044850 rewrote every schedule and every unfinished event. A second sweep on 2026-10-11 read the places the first one could not see: the live database catalog and the scripts outside `src/` and `server/src`. It found four sources that still wrote the sign into text a player or the owner reads.

## What Still Showed A Dollar Sign

- **The jackpot crossing notice.** `fn_bbj_notify_thresholds` wrote "The Bad Beat Jackpot Just Passed" and "The jackpot at ... is now" with the sign in front of the amount into every member's notifications, which also go out as phone pushes. A push is not rendered by the app, so the display boundary that strips the sign never saw it.
- **Player search labels.** `fn_search_players` put the sign in front of both blinds of a cash table and in front of an event's buy-in.
- **A new club's first schedule.** `fn_club_welcome_package_config` named the welcome schedule "Daily 25 Freezeout" with the sign in front of the 25, so every event it spawned, every table it opened and every push about it would carry the sign, while the welcome screen itself already said "Daily 25 Chip Freezeout". No club holds that schedule today.
- **The owner's daily estate digest.** `.github/scripts/estate-digest.mjs` posts its lines into the owner's Club Arena notifications, and one line put the sign in front of "1,100" when it named the August bill.

## The Fix

- Migration 20261011200429 (`the_jackpot_notice_and_search_show_no_dollar`, applied, and recorded here byte for byte) changes exactly those lines in the three functions, each behind an md5 pin of the function it expects and an exact-count anchor: the notice now says "Passed 1,000.00 Chips" and "is now 1,234.00 Chips", search says "0.5/1" and "25 Buy-In" ("Free Buy" when the buy-in is 0), and the welcome schedule is "Daily 25 Chip Freezeout" with its 25 buy-in unchanged. Both definer functions stay definers. No row is rewritten and no money moves.
- The estate digest says "1,100 USD bill", the form Dan gave for real money.

## The Gate Now Reads Where These Lived

`scripts/ci/check-ui-dollar.mjs` read only `src/`, `server/src` and `public/`, so none of the four could ever fail it. It now also reads:

- `.github/scripts`, where the estate digest lives.
- Migration SQL from this migration's version on. It reads only the single-quoted literals inside the code: comments are skipped, a function body opened by `AS` or `DO` is read as code, any other dollar-quoted block (a patch anchor quoting old text) is not read, and dynamic SQL that quotes its own literals is read one level in. Pattern arguments (replace, regexp, position, LIKE, `~`), positional parameters, format positions, JSONPath roots, regex end anchors and catalog comments pass; copy with the sign fails.

`tests/the-club-arena-shows-no-dollar-sign.law.test.ts` gains three cases: the three SQL shapes found (they must fail), the SQL machinery that spells the character (it must pass), and the gate's roots and first SQL version (it must read the estate digest and this migration, and this migration must pass it).

## What Was Checked And Found Clean

- Every client and engine string through the gate: clean. Every edge function: clean.
- Every database function and view in `public` and `smarter_private`: only the three above wrote the sign into copy.
- Data shown in Club Arena: schedules, unfinished events, clubs, unions, promotions, club announcements, shop items, commerce products, Diamond packages, wheel segments, daily bonus calendar, VIP rewards, BBJ thresholds and tiers: none hold the sign. Notifications and closed tournament tables written before the sweep still hold it as history; the app's display boundary strips it on screen, and they are left as written.

## Verified

- Freerolls: the four Midway and four Diamond Arena freeroll schedules each have upcoming occurrences, names "100 Chip Guarantee Freeroll" with no sign, and the description "100 Chip Guarantee".
- Satellites: the Sunday 200 Deep Stack targets exist in Midway and Diamond Arena for Sunday 2026-10-18, and all six satellite schedules have occurrences pointed at them.
