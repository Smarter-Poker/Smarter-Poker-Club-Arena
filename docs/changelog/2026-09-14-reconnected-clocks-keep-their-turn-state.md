# Reconnected clocks keep their turn state

A disconnected player's turn can be waiting on the disconnect countdown when
the player reconnects. The reconnect path armed the remaining primary clock
without moving the turn state out of `waiting`. Production cash-game logs on
September 14 showed the resulting invalid expiry transitions. Recovery clocks
had the same missing transition, which could also skip ordinary time-bank
eligibility.

The common clock-arm path now records whether it owns the primary clock or an
activated time bank. Both manual and automatic bank callers explicitly identify
their clock. This preserves the remaining reconnect deadline, bank suppression,
and per-turn allowance. A rejected timeout action arms its replacement clock and
returns without marking that clock complete, counting a timeout strike, or
announcing an action that the controller refused. Manual-bank expiry records its
accepted outcome through the same turn states.

The actual engine methods reproduce five failures on the previous source, with
two stale-seat/retired-engine controls passing. Ten permanent behavioral cases
exercise reconnect expiry, fallback bank eligibility, manual and automatic
banks, rejected actions, active-bank reconnect, and ownership controls. The
focused six-file timer/reconnect/watchdog set passes 70 cases. The complete
server suite passes 12,413 cases across 828 files; its 157 native PostgreSQL
cases remain in their separate fixture gate. Server TypeScript and formatting
pass; lint reports no errors and five existing unused-symbol warnings.
No production player action, chip write, or manual restart was used for
verification.
