# tests/a-diamond-spin-recovers-and-shows-its-top-prize.law.test.ts

A Spin whose launch was interrupted after it dealt - its draw committed, a
hand persisted, one player busted and vacated, its launch receipt still
incomplete - is finished through one narrow proof,
fn_prove_played_spin_launch_recovery. The manager reads it before it lowers
the field to the two survivors, the one draw authority reads it before it
replays the committed draw, and the launch completion reads it again under the
tournament lock. It read chip records only (refund entitlements, wallet debits,
their chip ledger legs, the owner's reserve draw and the chip escrow), so a
Diamond Spin in that state answered played_spin_launch_recovery_unproven and
stayed parked with its entries in custody.

The proof now routes a Diamond Spin to its Diamond arm,
fn_poker_diamond_prove_played_spin_launch_recovery, by one asserted
substitution (the live md5 pinned, the clause found once, the reverse
substitution proved): for a chip tournament it answers what it always
answered. The arm proves the same facts from the records a Diamond Spin keeps:
the three entry rows of the Diamond tournament ledger where a chip Spin has its
entitlements, the players' own reserve movements into the event's custody
where it has its wallet debits, each entry's active custody, registration,
movement and wallet journal where it has its source ledger legs, the one
committed Diamond draw read back by fn_poker_diamond_spin_draw_proof where it
has its reserve contribution, draw, pool and journals, and the Diamond banks
and custody holding exactly the drawn pool where it has its escrow. The field,
the felt, the vacated seat and the hand are the chip proof's own text, copied
verbatim, and the answer has the chip answer's shape, so the manager's reader
and both database callers take it unchanged. The arm reads no chip record and
is owner-only.

The Diamond arm of the draw authority, fn_poker_diamond_spin_draw, is pinned
and redefined with the same signature: it reads its field as the chip
authority does, so two players and a proven played recovery read the original
three, the bust included, and the committed receipt replays; nothing moves
twice.

The engine's launch setup proof read a Spin's one jackpot_draw in the chip
reserve ledger before it would admit RUNNING, which a Diamond Spin never
writes; for a tournament whose unit is the Diamond it now reads
fn_poker_diamond_spin_draw_proof and holds the row and the manager's copy to
that draw (diamondSpinLaunchProof.ts).

A filling Spin advertises "Win Up To" the top of its table. A Diamond Spin's
table is the one its creation pinned, which no browser may read;
fn_poker_diamond_spin_ceilings answers that table's top multiplier for each
Diamond Spin id it is given and nothing for any other id, to signed-in players
only, and moves nothing. The lobby learns which rows are Diamond Spins from the
arena embed (TOURNAMENT_ARENA_EMBED, #5050), asks only for those, and prints
no figure for a Diamond Spin whose top it has not read. A chip Spin says what
it always said.

The law pins the route and its reverse proof, the verbatim field rules, the
Diamond money evidence and the absence of every chip record from the arm, the
answer's shape, the draw arm's played field, the read door's grants, and the
closing assertions (nothing authorized, the switch closed, the identity whole,
every watched guard on its baseline).
