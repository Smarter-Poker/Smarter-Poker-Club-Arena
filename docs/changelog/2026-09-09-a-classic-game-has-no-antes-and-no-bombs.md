# 2026-09-09 — A Classic game has no antes and no bombs

Back in the must-move feeder game, where this work belongs. Two defects, both
live, both touching seated players.

## 1. The template was a default, not a promise

The lobby prints the template under every game title, and the picker tells the
player exactly what it means:

| template | what the player is told                                             |
| -------- | ------------------------------------------------------------------- |
| classic  | "Standard Ring Game. No Antes, No Bombs, No VPIP Floor."            |
| action   | "Small Blind Ante, VPIP Floor, Double Board Bomb Every 15 Minutes." |
| madness  | "Big Blind Ante, High VPIP Floor, Double Board Bomb Every Orbit."   |

`fn_cash_template_defaults` already returns exactly those rules. **Nothing
enforced them.** The creation path let the caller's overrides win:

```sql
v_ante  := coalesce(v_o->>'regular_ante', v_def->>'regular_ante');
v_vpip  := fn_cash_override_int(v_o, 'vpip_floor', ...default...);
v_bombs := coalesce(v_def->'bombs','{}') || coalesce(v_o->'bombs','{}');
```

and validated only that the _value_ was legal, never that it matched the
template the game is sold as.

**It happened.** Measured 03:50 UTC: 23 of 88 `classic` games carried
Action/Madness rules. On the felt that was **24 classic tables running bomb pots
and 19 charging an ante**, inside 389 seated classic players. `NLH 0.50/1
Classic` had 10 tables and 48 players taking a double-board bomb every fifteen
minutes in a game that says No Bombs; `NLH 0.25/0.50 Classic` had 8 tables and 30
players paying an ante in a game that says No Antes.

An ante is forced money out of a stack. Taking it in a game advertised as having
none is not a cosmetic mismatch.

**The rule now:** the fields named in the blurb come from the template and are
not overridable — `regular_ante`, `vpip_floor`, `vpip_window` and the whole
`bombs` object. Everything else a host still edits: buy-in band, stay clock,
rejoin window, handedness, table options. The line is "did we promise this to the
player when they picked the game". The 23 existing games were realigned in the
same migration, which asserts afterwards that none disagrees with its template.

## 2. A table that was open and closed at the same time

`tables` carries two liveness fields. `fn_cash_cluster_tick` already repaired one
direction, and its own comment names the cause — an operator close and the
pre-controller path write `status` only. The **mirror had no repair at all**, and
it is the one that reaches a player:

`lifecycle = 'closed'` with `status = 'waiting'`. The lobby and every
status-based read treat that table as joinable, while `fn_cash_apply_ruleset`
skips it — its `WHERE` is `t.lifecycle <> 'closed'` — so it can be sat at while
carrying a ruleset nothing reconciles.

**32 fleet tables** were in that state, the oldest since 09-04. Five were still
advertising an ante or bomb pot _after_ their game had been corrected above,
for exactly this reason: the reconciler could not see them.

The repair is symmetric with the one that exists. An **empty** closed-lifecycle
table has its status follow down; one with a seat is already sent back to
`breaking` by the sweep further up, which walks it empty first, so nobody is
closed out from under. It emits `status_followed_lifecycle` so the repair is
visible rather than silent.

## I got the ordering wrong once, and it mattered

The first apply inserted the new block **between** the lifecycle-follows-status
`UPDATE` and its own `GET DIAGNOSTICS v_n = ROW_COUNT`, silently stealing that
statement's row count for my event. `GET DIAGNOSTICS` reads the statement
immediately before it. Corrected in the same session by moving the block below
the pair it had split, and the migration now anchors on the **complete** pair so
it cannot split one again.

## Verified through a live maintenance break

Applied at 03:53, three minutes before the scheduled `:55` break. During the
freeze `games_ticking` read 0 — which is the break working (`fn_platform_frozen`
short-circuits the tick), not a regression, and I checked `fn_platform_frozen()`
rather than assuming either way.

On the first tick after the 04:00 thaw:

|                                           | before              | after |
| ----------------------------------------- | ------------------- | ----- |
| Classic tables with an ante or bomb pot   | 24 bombs / 19 antes | **0** |
| Tables `waiting` but `lifecycle closed`   | 32                  | **2** |
| `status_followed_lifecycle` repair events | —                   | 15    |
| Games disagreeing with their template     | 23                  | **0** |
| Games ticked in 3 min                     | —                   | 109   |

Action and Madness were correct throughout and remain so: 29/29 tables on
`timed`, 28/28 on `once_per_orbit`, antes and VPIP floors on every one.
