# tests/a-vacated-seat-closes-its-session-at-commit.law.test.ts

Twelve functions vacate a cash seat and one closes the player's session; a
bust through hand settlement leaked it on a table that stays open. Pins the
DEFERRABLE INITIALLY DEFERRED constraint trigger on table_seats.left_at that
closes any session still open at commit as 'seat_vacated', and pins WHY it is
deferred: atomic_seat_cashout_locked vacates first and closes after, and that
close writes the rejoin-window and VPIP-eviction bars - a trigger firing at the
vacate would close the session first and the bar would silently never be
written. Every proper close in the transaction wins; only a session nobody
closed is left for the trigger. Also pins cash-only scope, the transition
guard, the catalog post-condition, and that it never routes through the
bar-writing path.
