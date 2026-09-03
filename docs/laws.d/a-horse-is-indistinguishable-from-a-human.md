# tests/a-horse-is-indistinguishable-from-a-human.law.test.ts

Dan, 2026-09-02: "HUMAN USERS CAN NEVER KNOW THAT THIS IS A 'HORSE' AND NOT A
'HUMAN'. MAKE SURE THERE IS NO DIFFERENCE BETWEEN THAT AS ITS DISPLAYED." The
client half of that rule, and the same policy as 10.5 pointed at the other
audience: 10.5 forbids EXCLUDING horses and permits the flag as data on staff
surfaces; this forbids REVEALING it on any surface a player can reach - a
query column, a React prop, a DOM attribute, rendered text, or the bundle. What
a player could see before it shipped: `getSeatedPlayers` selected `is_horse`
on every table open; the felt pulled `horse_id` on its seat reads and set an
`isHorse` prop on every seat (React DevTools); a 15-second poll asked
`profiles?...&is_horse=eq.true` for the people at the player's own table, to
retire one - and the retirement had been a refusal since chip standard C1, so
it leaked and did nothing; the cashier roster printed " (Horse)" beside a name
to every agent; friend suggestions put `is_horse=eq.false` in the request URL;
and one import on a union page bundled the entire 2,400-line horse orchestrator
into a player's download. Re-landed 2026-09-07 after a 09-03 fix had put
`horse_id` back on the seat reads as "the flag the felt needs" - nothing on the
felt branches on it, and the 09-05 backfill had since populated it into a live
seat-to-horse map. The law scans player-facing files with comments stripped,
feeds the snapshot mapper a horse-flagged seat and asserts nothing horse-shaped
survives, asserts no page or component imports a horse service, and pins that
the staff club dashboard and the fleet services KEEP their identification.
