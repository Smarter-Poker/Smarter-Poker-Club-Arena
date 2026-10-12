# 2026-10-11 - Aces full of Jacks is the floor, both cards play for the Mini, and Share & Invite

Dan, 2026-10-11:

1. "BBJ for Holdem is Aces full of Jacks but it's paying out any aces full as a
   BBJ (DO NOT TAKE THEM AWAY, OR CHANGE THE PREVIOUS RESULTS, JUST MAKE SURE THAT
   ITS HARD CODED THAT ACES FULL OF JACKS WITH BOTH CARDS PLAYING IS THE STANDARD."
2. "BOTH cards must play for BBJ or Mini BBJ"
3. "Remove the 'Level 29' under the playing Now and replace that with 'Share & Invite'"

## 1. The main jackpot paid any aces full

**Cause, read from rows.** `doesHandQualify` (server/src/config/RakeConfig.ts)
read a full house's pair as `kickers[1]`, believing the kickers were
`[trip, pair]`. The engine's evaluator (`getKickers` in PokerEngine.ts) returns all
five ranks grouped by count, so AAA66 is `[14, 14, 14, 6, 6]` and `kickers[1]` was
the second Ace - always 14 - and every aces full cleared the Jacks floor. Every
existing test passed hand-written `[14, 11]` kickers, the one shape the live
engine never sends, so none could see it.

Live evidence: main payout `5dbdd309` (2026-10-11 07:34 UTC, NLH, board 9 6 6 A 3)
paid 32,244.10 on pocket aces - Aces full of SIXES - beaten by pocket sixes. The
lobby list also shows Aces full of Fours paid as a main on 2026-10-02.

**Fix.** The pair is now the first rank that is not the trips
(`fullHousePairRank`), correct in both encodings. Aces full of Jacks or better,
an Ace in hand, and both hole cards playing remain the main hold'em rule.

**Past results are untouched**, as Dan instructed. No payout row, recipient or
balance was changed; the rule governs new hands only.

## 2. Both hole cards must play for the Mini too

The Mini deliberately dropped the both-cards-must-play rule until today. It now
applies it exactly as the main does - to the losing hand and the winning hand, in
the hold'em family (NLH, FLH, Pineapple), failing closed without a board. Omaha is
game-enforced (exactly two always play). Settlement and the Lightning path both
pass the board to the Mini now.

Hands like these stop paying the Mini: board quads (board 3 3 3 3 5, paid live
2026-10-11 04:52 UTC) and aces full where a hole card was dead weight (board
A 6 K A A, K-7 vs A-8, paid live 2026-10-11 22:31 UTC). A hand that falls below
the new main floor but plays both cards - aces full of sixes - is now a Mini.

The Mini's near-miss record gains `mini_both_cards_must_play`, labelled on the
operator analytics panel. Player-facing copy on the Qualifying Hands panel and the
Mini rules (`src/config/bbjMini.ts`) says both hole cards must play.

Pinned by `server/src/config/acesFullOfJacksIsTheFloor.law.test.ts`, which builds
every hand from the real evaluator so the encoding the detector reads is the one
settlement passes.

## 3. Share & Invite replaces the club level

The blue plate under PLAYING NOW on the club identity card printed "LEVEL N". It
now reads "Share & Invite" and is a button that opens the same invite the copy
frame does (native share sheet, or copies the invite link). The text is fitted by
measurement into an inset box so it never touches the painted rim; rendered at
393px before and after. The Diamond Arena rail, which covers that plate, is
unchanged.

## Found, not changed

`fn_bbj_recent_hits` reads `bbj_payouts.winner_user_id` as the bad-beat holder,
which is how main payouts are written. Mini payouts are written the other way
round (`winner_user_id` is the hand winner; the 50% share correctly goes to
`loser_user_id`), so the Mini tab names the two players swapped. Money is right;
only that list's labels are.
