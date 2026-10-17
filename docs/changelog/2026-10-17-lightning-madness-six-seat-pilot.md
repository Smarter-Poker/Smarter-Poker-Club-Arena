# Lightning pilot Madness moves to six seats

**Owner decision, 2026-10-17:** replace the nine-seat private-pilot Madness target with a six-seat one.

## Measured cause

The private Lightning pilot could not reach its Madness population. Read-only at 10:43 UTC: Action held 44 live eligible against its ON threshold of 18; Madness held 4 against 27.

The blocker was not participant availability. On the nine-seat pilot Madness (floor 50) horses played **49.9% VPIP** over 3,041 hands, pinned at the widening layer's ceiling (`vpipFloorMul`, clamp 0.35), so **92% of sittings ended `vpip_evicted`** and each wrote the two-hour bar from `fn_cash_session_close`. At 10:45 UTC, 57 of the 72 assigned pilot horses were barred from it. The same fleet on six-seat floor-50 Madness elsewhere played **59.3%** and 32% of those sittings ended in eviction over the same window.

Six seats is Madness's own template default (`fn_cash_template_defaults`); nine was a pilot setup choice. A six-seat game's thresholds are 18 ON / 12 OFF (`fn_cash_cluster_lightning_thresholds`).

## Change

- `PILOT_TARGETS` Madness is now `Lightning Pilot NLH Madness 6`, six seats, same 0.02/0.04 stakes and Madness rules, with its own control request IDs.
- `RETIRED_PILOT_TARGETS` lists the nine-seat game. Preparation closes it only through the club owner's ordinary `fn_execute_managed_game_command` close, which refuses while anyone is seated: nobody is stood up, moved or cashed out. It reads the close back before creating the replacement, because both use the same one-per-key and one-per-band stake slot. A refusal stops the run with nothing created; the same setup is simply run again later.
- Stage targets are chosen by template (`action`, `madness`); the old `6` and `9` inputs still mean Action and Madness. Qualification blockers are named by template.
- The pilot assignment resolves its targets by maintained name instead of carrying the retired UUID.

Unchanged: the 50% floor, the ten-hand window, the two-hour bar, rest/caps, the 72-player assignment and its manifest, funding, Classic games and every Action setting.
