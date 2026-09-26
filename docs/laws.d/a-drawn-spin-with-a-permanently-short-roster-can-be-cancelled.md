# tests/a-drawn-spin-with-a-permanently-short-roster-can-be-cancelled.law.test.ts

13 Spin tournaments drew a real multiplier and moved real chips into their
prize liability, but their receipt was never written and the launch that
deals the hand never ran; every one has since permanently dropped below the
three active seats a relaunch requires, so they could neither relaunch nor
cancel. `atomic_cancel_tournament` refused ANY tournament with a stamped
multiplier or a jackpot_draw row, unconditionally, even though the function
already has more precise clauses for genuine in-play evidence. Migration
`20260922225837_legacy_drawn_never_launched_spin_settles.sql` fixes this at
the root: the guard now only refuses a drawn Spin when its active roster
could still plausibly relaunch (exactly 3), a narrow cache-sync closes the
untested tournaments-cache-vs-escrow gap this exposed, and
`fn_ca_tournament_refund_plan` is given the same Spin fee-accounting
exemption `fn_spin_draw_and_settle_atomic`'s own header already documents
needing. This pins that all three patches keep their safety conditions
intact - never a bare, unconditional relaxation - so a later edit cannot
quietly widen this into "any drawn Spin can be cancelled" and reopen the
exact race (cancelling a Spin that is genuinely mid-launch) this law exists
to prevent.
