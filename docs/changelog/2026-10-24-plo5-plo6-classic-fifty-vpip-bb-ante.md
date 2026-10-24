# PLO5 and PLO6 Classic: 50% VPIP and a BB ante, every stake (2026-10-24)

Dan: "MAKE THIS ADJUSTMENT NOW TO ALL PLO5 AND PLO6 CLASSIC GAMES. 50% VPIP AND
BB ANTE FOR ALL STAKES." Classic games are the must-move feeder games, not
Lightning.

- `fn_cash_template_defaults('classic', 'plo5'|'plo6')` now promises a big blind
  ante and a 50% floor over 10 hands. No bomb pots. Every other Classic variant
  and every Lightning game is unchanged.
- All 35 open PLO5/PLO6 Classic games were rewritten through the floor trigger
  and projected to their tables; applied at 21:33 UTC. Every hand dealt on
  those tables since carries the ante.
- `fn_nit_check` starts a sitting's maintain window at the later of the roster
  join and the game's `vpip_floor_since`, so players seated under the old 0%
  floor were not stood up and barred for hands played before the change.
- Pinned by `tests/unit/plo5Plo6ClassicFiftyVpipBbAnte.test.ts`.
