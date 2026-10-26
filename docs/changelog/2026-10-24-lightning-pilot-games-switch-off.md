# Lightning pilot games: switch off after the drain (2026-10-24)

Step 2 of 3 in standing down the two horses-only Lightning games left in the
Lightning Internal Pilot club (NLH 0.01/0.02, NLH 0.02/0.04). Step 1
(`20261024201850`) drained both through the operator door; the drive reverted
them to must-move with every horse still on its anchor seat and stack.

`20261024213143` switches both games off through the owner's own door,
`fn_cash_game_switch_off`, as the club owner (claims carry `sub` only, the
trusted migration context). It writes `enabled = false` and its audit event and
moves no chip and no seat. The live engine's horse rotator then stands each
horse up at the end of its hand through the ordinary per-seat cash-out into its
own club wallet, exactly as a person leaving a switched-off game, and the
cluster tick closes each table once it is empty. It refuses whole unless both
drains are complete and both games read must-move with Lightning off.

Step 3 closes both games (`closed_at`) once no seat is occupied.
