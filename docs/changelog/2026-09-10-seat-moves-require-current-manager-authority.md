# Seat Moves Require Current Manager Authority

The prepared strict tournament cutover fences the obsolete
`fn_move_tournament_player_atomic` route but omits the actual engine RPC,
`fn_move_tournament_player`. That RPC checks service authority. Without the
request-route fence, a callback that loses manager context can enter it as
an ordinary service actor. The row scope guards only constrain marked managers.

The correction binds the current route to the existing exact fresh manager
lease check while retaining the legacy route's refusal. Immutable seat-move
receipt resolution must remain available to service recovery after lease loss.
A disposable PostgreSQL rehearsal executes the actual prepared request hook
under API roles, with real lease rows and both gateway path shapes. It certifies
request admission only, not seat mutation economics or the entire cutover.

No production migration, financial correction, table lockout or incident closure
is included in this narrow source correction. The complete strict cutover
remains pending its other financial acceptance gates.

## Verification

The original prepared hook admitted an unmarked service request on
`/rpc/fn_move_tournament_player`, reproduced in PostgreSQL 17. The corrected
hook passes 32 admission scenarios across current and legacy names, direct and
gateway URL shapes, valid/replaced/expired manager leases, ordinary service
actors and authenticated players. Service receipt recovery and authenticated
rebuy/decline still work. Run
`python3 scripts/dev/probe-tournament-seat-move-fence-pg17.py`.
No actual seat mutation or financial transaction is substituted into this test.
The complete corrected cutover script also installs and passes its postflight on the owned isolated schema. This is installation evidence, not complete financial acceptance. Re-read: yes.
