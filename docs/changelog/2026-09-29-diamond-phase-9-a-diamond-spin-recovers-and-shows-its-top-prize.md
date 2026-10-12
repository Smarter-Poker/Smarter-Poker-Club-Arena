# Diamond Phase 9: A Diamond Spin Recovers And Shows Its Top Prize

Status: the two gaps the Diamond Spin left open (`a_diamond_spin_draws_a_whole_prize`, "What Is Still Not Here") are closed, behind the switch. Diamond tournaments remain refused at every door (`tournaments_enabled` is false) and no reserve source is authorized. This is the Spin tournament format, not the Diamond Spins bonus wheel.

## The Database

Migration `a_diamond_spin_recovers_and_shows_its_top_prize` (applied as `20260929181500`; stored text byte-identical to the repo file, md5 `55f8cda4e6e4f2ad18f86e66b9076c86`):

- `fn_prove_played_spin_launch_recovery` routes a Diamond Spin to its Diamond arm by one asserted substitution (pinned `8bc978cc105c18b2e3350016b48a50eb`, reverse proved). A chip tournament's answer is unchanged.
- `fn_poker_diamond_prove_played_spin_launch_recovery` (new, owner-only, reads only): the chip proof's field, felt, vacated-seat and hand rules copied verbatim, with the money read from the Diamond records - the three ledger entry rows, the players' own reserve movements into custody, each entry's active custody, registration, movement and wallet journal, the one committed draw read back by `fn_poker_diamond_spin_draw_proof`, and the banks and custody holding exactly the drawn pool. Same answer shape as the chip proof.
- `fn_poker_diamond_spin_draw` (pinned `b6bc15048a340464e845ee3f880cc325`, redefined with the same signature): reads its field as the chip authority does, so a proven played Spin replays its committed draw instead of being refused `spin_field_unproven`.
- `fn_poker_diamond_spin_ceilings(uuid[])` (new, signed-in players, reads only): the top multiplier of each Diamond Spin's pinned table; nothing for any other id.

## The Engine

- `TournamentManagerBase.proveTournamentLaunchSetup`: a Spin's settlement check read the chip reserve ledger's `jackpot_draw`, which a Diamond Spin never writes, so every Diamond Spin launch (fresh or recovered) would have stood down before RUNNING. For a tournament whose unit is the Diamond it now reads `fn_poker_diamond_spin_draw_proof` and holds the row and the manager's copy to that draw (`diamondSpinLaunchProof.ts`). The chip check is unchanged.

## The Client

- `lobbyEntries.spinCeilingMultiplier`: a chip Spin advertises the chip ladder's ceiling exactly as before; a Diamond Spin (by the arena embed, #5050) advertises the top of its own table, and no figure while that is unread. Used by the lobby's Max Payout column, the game cards and the tournament card.
- The club lobby and the tournament lobby read the arena embed and, only when a Diamond Spin is on the board, `fn_poker_diamond_spin_ceilings` (`services/diamondSpinCeilings.ts`).
- The two Spin game cards print no figure, not "100x", when a Spin's ceiling is absent (only a Diamond Spin whose top is unread reaches that).

## The Rehearsal

One rolled-back transaction through the real doors, every deferred constraint forced at each commit point, before the apply: the routed proof answered the 40 most recent drawn chip Spins, a running non-Spin and an unknown id exactly as the pinned chip text does (42 of 42). Two Diamond Spins were created (a 1x/4x table and the published table); the lobby read answered 4 and 100 for them and nothing for a chip Spin, and refused an anonymous caller. The 1x/4x Spin filled with three Diamond seats, its launch began and it drew 4x (the house underwrote 10 into custody); the launch was then left unrecorded while the table dealt - the start stamped from the receipt as the engine that dealt left it, a hand persisted, one player busted and his seat vacated. The proof answered played for it in the chip answer's shape (the pinned chip text could not). A new launch claim adopted the incomplete receipt, the draw authority replayed the committed draw moving nothing, and the launch completed RUNNING with the two survivors. The game then finished through the real terminal: 40 Diamonds to the winner, every custody released, every bank closed, the house untouched by the terminal, and the supply identity unchanged throughout (production 0.00 before the fixture).

## Dan's Question

None new. The reserve source question from `a_diamond_spin_draws_a_whole_prize` still stands: until it is answered every Diamond Spin is refused by name at creation.

Law: a-diamond-spin-recovers-and-shows-its-top-prize.
