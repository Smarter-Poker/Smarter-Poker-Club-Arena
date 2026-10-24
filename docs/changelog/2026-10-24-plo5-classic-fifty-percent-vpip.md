# Classic PLO5 plays at a 50% VPIP floor

Dan, 2026-10-24: "just make the plo5 classic to 50% vpip and stop. thats it.
then relaunch the game." Scope confirmed as every PLO5 Classic game.

Migration `20261024212524_plo5_classic_plays_at_a_fifty_percent_vpip_floor.sql`:

- `fn_cash_template_defaults('classic','plo5')` now returns `vpip_floor` 50
  (window 10 hands). Every other template and variant is unchanged; the
  migration asserts that before it writes anything.
- Every non-closed Classic PLO5 game is re-stamped, so the floor trigger copies
  50 into its snapshot. Dormant games pick up the floor when re-enabled.
- Relaunch: each enabled game is projected through `fn_cash_apply_ruleset`,
  which sets `nit_game`, `maintain_percent_min = 50` and `maintain_hands = 10`
  on its open tables. The engine re-reads these between hands, so the floor
  applies from the next hand and nobody is unseated.

Not changed: the Classic template blurb in `src/config/cashGames.ts` still
reads "No Minimum VPIP" for Classic in general. A PLO5 Classic game's own info
rows read the snapshot and print "50% Over 10 Hands".
