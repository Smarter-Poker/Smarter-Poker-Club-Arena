# 2026-10-17 - Five lobby fixes from Dan's 2026-10-16 screenshots

Dan, 2026-10-16, with eight screenshots of the desktop and phone lobby:

1. "on the description for action and madness, it should change from VPIP FLOOR to the actual vpip % same thing for madness. 'high vpip' should state the minimum requirement. and change it from bomb pot every orbit to every 10 minutes for madness and every 20 minutes for action."
2. "CURRENT NLH YOU CAN'T EVEN SEE THE DESCRIPTION, REMOVE THE DUPLICATED 'NO LIMIT HOLDEM' AND MAKE SURE THE DESCRIPTION IS LOCATED THERE, WITHOUT BEING CUT OFF."
3. "BEFORE YOU JOIN A TABLE, IT SHOULD DISPLAY THE GAME TYPE ONE MORE TIME SOME WHERE ABOVE OR BELOW THE 'BUY IN SELECTION'"
4. "ON THE 'QUICK JOIN' MAKE THIS DOUBLE THE CURRENT SIZE, YOU CAN'T SEE ANYTHING... ITS TOO SMALL."
5. "FOR THE PLO GAMES. RAISE THE 'RUNNING' AND EMPTY UP HIGHER SO ITS NOT SO CLOSE TO THE DESCRIPTION FONTS."

## What changed

1. **Descriptions and cadence.** Action reads "Small Blind Ante, 30% Minimum VPIP, Double Board Bomb Every 20 Minutes"; Madness reads "Big Blind Ante, 50% Minimum VPIP, Double Board Bomb Every 10 Minutes" (`src/config/cashGames.ts`, one source for the picker, the cards and the desktop board). The figures are printed because all four are template-locked: a host cannot override them. The cadence is real, not only words: migration `20261017105834` changes `fn_cash_template_defaults` to `timed_20m` / `timed_10m`, teaches the three projections (`fn_cash_apply_ruleset`, `fn_cash_cluster_open_table`, `fn_cash_game_create_impl_20260905`) the new tokens (600 s and 1200 s; the old tokens stay readable), rewrites every non-retired Action/Madness snapshot from the template and projects it onto the open tables. Each function is patched by exact text replacement guarded by its reviewed md5, so a changed definition refuses the migration. No engine change: the engine already deals `timed` at any interval and re-reads it at hand boundaries.
2. **NLH style line.** A templated NLH game whose name already says its style printed "No Limit Hold'em" as the style word, which the title and the painted NLH badge already say, and it left the note a third of the row. The line now carries only the club (when shown), so the note has the whole row and wraps to two full lines (`arenaGameCardAdapter.ts`, `LayeredCard.css`).
3. **Buy-in names the game.** The long game name ("No Limit Hold'em", "Pot Limit Omaha 6") prints in gold above the amount (`BuyInModal`, `gameTypeLongName` in `src/utils/handFormat.ts`).
4. **Quick Join doubled.** The sheet is `min(680px, 100vw - 24px)` (was 340px); every size inside is cqw, so the art and type double. Below 704px, where the width cannot double, each row's type doubles and the row wraps to two lines.
5. **PLO status pill raised.** New chassis `chassis-5df05c9d8f72.png`: the approved `b0b05b302c99` master with only its status-pill block moved up 36 source px (42 canvas units), the vacated strip filled with the well's own texture, edited in palette mode so every pixel keeps its original colour. The status zone moved with it and the note zone grew to hold two full lines. The previous chassis stays at its permanent URL.

Rendered headless at 393px (cards, buy-in, Quick Join) and 1280px (Quick Join) before merge.
