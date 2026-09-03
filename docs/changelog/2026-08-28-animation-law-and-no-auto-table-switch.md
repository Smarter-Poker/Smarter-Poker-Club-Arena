# The Animation Law + No Auto Table Switching (2026-08-28)

Dan: "HARDEN THE PROCESS AND MAKE SURE THAT ANIMATIONS CAN'T REGRESS... MAKE
IT LAW THAT THEY MUST ALWAYS PLAY." And: "YOU CAN NEVER EVER AUTO CHANGE
TABLES FOR A USER, THEY MUST CHANGE IT BY THEM SELF."

## 1. The Animation Law — CI-enforced

`tests/animations-always-play.law.test.ts`: 20 pins, each one a real shipped
bug from the 2026-08-27/28 audits — silent celebration cues (zero-volume
playTone), the suppressed pot-collect sweep, per-card deal sounds dropped
under load, throwable audio dead on mobile, MasterBus dedup eating animation
events, celebrations restarting on tab switches, off-screen throw origins,
canvases latched in hidden tabs, the deal lost to the roster race, showdown
flips cancelled mid-hold, chips displaced by the shake, speed-blind CSS/JS
pairs, the reduced-motion turn clock, duplicate reaction glyphs, panels
un-muting players, and the retired skip/auto-switch toggles. The suite runs in
the required vitest check, so nothing merges past it. CLAUDE.md section 10.6
carries the law itself: never weaken a pin — move it with the mechanism, in
the same commit.

## 2. No auto table switching — deleted, not defaulted off

Two features moved the active table without a user gesture:

- the URGENCY AUTO-SWITCH: yanked the view to any table whose turn clock fell
  under 5 seconds — exactly the "auto swipes to the table running out of
  time" Dan reported;
- the ACTION QUEUE: advanced to the next waiting table the moment the hero
  acted.

Both effects are deleted from MultiTablePage and their toggles removed from
the settings panel (keys tombstoned; DB columns dead). Every signal survives —
the background-urgency bell, the 5-second tab flash + haptics, the browser-tab
retitle. Only the move is gone: `setActiveIndex` now runs only from the
player's own gesture, the mount-time restore of their own last tab, or the
bounds repair when a table closes. `tests/no-auto-table-switch.law.test.ts`
pins all of it, including a shape-guard against any future timer-driven
`setActiveIndex`.
