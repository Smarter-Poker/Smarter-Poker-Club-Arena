# 2026-10-12 - Audit of the 2026-10-11 jackpot and Share & Invite work

Dan, 2026-10-12: "CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR
WIRING ISSUES ANYWHERE AND EVERYWHERE." Read as: everything the 2026-10-11 changes
touch (both jackpot tiers end to end, the rules screens, the club identity card)
plus live production since the engine release. Display and rules-copy fixes are in
`2026-10-12-bbj-display-and-rules-copy.md`; this file covers the engine and the
card.

## Engine (server/src/config/RakeConfig.ts, ServerTableEngineSettlement.ts, ServerTableEngineRunout.ts, lightning/LightningJackpot.ts)

1. **The jackpot judged the table's game, not the dealt game.** Settlement read
   `tableInfo.game_variant`, so a PLO table running an NLH bomb pot was judged
   by the Omaha rule (a board-quads hand could pay the main), and an NLH table
   on the Pineapple switch by the hold'em bar. It now reads the dealt variant
   (`bbjJudgedVariant`). Latent in production today (one override table, already
   excluded as double board), now closed.
2. **Run it twice: only the first runout counts, and now it really does.** Losers
   were "everyone not paid on any run", so a board-one bad beat whose holder won
   run two was never judged. The jackpot now gets board one's own winners
   (`currentHandBoardOneWinners`); the rest of settlement is unchanged.
3. **Chopped pot near miss.** The main near miss looked at one winner, so a
   co-winner was filed as a loser (a bogus near-miss row and table message). It
   now takes every winner, as the hit does.
4. **Double board near miss.** The main near miss had no double-board gate, so
   a double-board hand that cleared the main bar was recorded as a Mini near
   miss. New reason `double_board`, labelled on the operator panel.
5. **Lightning near misses** were never recorded; they now are, the same way as
   physical tables, and can never break a hand.
6. Hold'em-family both-cards checks now require exactly two hole cards.

Not changed, a rules question for Dan: a player who lost the main pot with a
qualifying hand but won a side pot, or lost the high half of a hi-lo pot and won
the low, is still not treated as the loser.

## Club identity card (Share & Invite)

- **Tap target.** The plate was a second button about 23px under the painted
  share frame; on a phone the two 44px thumb bands overlap, and the production
  tap-target sweep measured the plate at 0px reachable (post-deploy run
  38206133852). Fixed in parallel by #6728 (the plate's words are now printed
  inside the share button: one control, one action); this change keeps that.
- **Readability.** The card is half the phone width in the lobby, so the label
  rendered about 3.3px. It now uses Roboto Condensed (already loaded, the house
  label face): 4.7px on a 393px phone, about 43% larger, without touching the
  painted rim.
- **The invite itself.** The share sheet now opens inside the tap (the player
  number is already loaded, so the profile read only runs when it is missing;
  Safari refuses `navigator.share` once the tap's activation has lapsed), a
  refused sheet falls back to copying the invite, and closing the sheet is no
  longer reported as an error.

## Live production check (since the 05:55 UTC engine release)

Engine serving the release, no stalled tables and no blocked settlements; about
21,000 hands dealt in the first 25 minutes across every variant; no jackpot
payouts or near misses in that window, which is within the normal rate (about
13 near misses a day).
