# The Free Buy audit reads the board an event ran on (2026-10-17)

After #7271 went live at the 13:55 break, the Free Buy audit warning
(`40891e05`) stayed open. Replaying the audit against the 20 board rows it
reads on production left four problems, all the same:

- Midday, Afternoon and Prime Time Free Buy, 2026-10-16 12:00, 16:00, 20:00
- Midnight Free Buy, 2026-10-17 00:00

All four are COMPLETED. They ran at the top of the hour on the board they
were published on, before `20261017105003` moved every unstarted Free Buy
onto the half hour (the first moved slot was 2026-10-17 08:00 -> 08:30
Chicago). The audit reads 24 hours back, so it would have called finished,
on-time play wrong until about 05:00 UTC on 2026-10-18.

`FREE_BUY_HALF_HOUR_SLOTS_FROM_MS` (2026-10-17 13:00 UTC, the first slot of
the half-hour board) now excuses exactly minute 0 for an event that started
before it. Every slot from then on must start on the half hour, and any
other minute before it is still wrong. Replayed against the same 20
production rows, the audit finds nothing, so the watch closes its own alert
at its next pass.

Pinned in `server/src/services/FreeBuy.test.ts`.
