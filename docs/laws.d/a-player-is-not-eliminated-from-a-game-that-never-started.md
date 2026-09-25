# tests/a-player-is-not-eliminated-from-a-game-that-never-started.law.test.ts

Thirteen Spin tournaments dealt, played and in eleven cases decided a winner
while `tournaments.started_at` stayed NULL and the status stayed REGISTERING,
stranding 669.00 of collected buy-ins with 446.00 still held as prize and 53.52
as fee, none of it paid and none refunded. That state is unreachable by every
recovery path at once: the unfilled-Spin expiry refuses it because the Spin has
drawn, the crash and finished-but-not-completed sweeps cannot see it because
both key on a tournament that started, and it can never launch again because
`fn_spin_draw_and_settle_atomic` must prove three paid entrants. Every
violating row the platform has written appeared in one 61-minute window on
2026-09-08, just after the launch path was cut over to the atomic lease and
receipt authority. This law refuses the write that creates it: a registration
may reach `eliminated` or `winner` only if its tournament started, or if that
tournament is terminal. Refusing it keeps all three entrants registered, which
is the one state the existing draw authority can still adopt and relaunch, so
no sweep is needed. The trigger must stay DEFERRABLE INITIALLY DEFERRED because
`atomic_cancel_tournament` eliminates before it cancels, and an immediate
reading would refuse every refund on the platform.
