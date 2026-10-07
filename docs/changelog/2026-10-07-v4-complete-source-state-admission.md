# V4 Complete Solver State Admission

The existing source node door accepted only the 12-field V3 policy node. The
V4 producer adds complete solver-effective public state and two exact range
vectors; admission must bind that shape to approved immutable input metadata,
not infer a version from an untrusted node.

Migration `20261007043945` follows metadata migration `20261007043848`. It
preserves the exact physical-role-qualified V3 predicate under a private
versioned name and dispatches explicitly. V4 retains every V3 action, deck,
frequency, EV, chronology and checksum gate through a transient V3 projection,
after verifying the original full V4 checksum. No source row is rewritten.

The new reconstruction independently replays the validated Pio node's chip
payments, acting player, street, board, contributions, remaining effective
stacks, full-raise increment and public action history. The complete-state
object must equal that reconstruction. Utility fields are separately validated
and the ICM bundle checksum is matched to the approved dataset. Numerical rake
and model inputs remain bound to the immutable signed worker/manifest source;
the database does not claim to reconstruct their original file from its hash.

Both range vectors have exactly 1,326 finite numeric weights in [0,1], with
board-blocked combinations exactly zero. Positive matchup weight requires
positive acting-player range weight. No undocumented equality between Pio's
matchup normalization and the raw opponent-range sum is invented.

Admission normalizes the optional checksum on exactly 13 worker fields into
14 database fields. Supplied checksums remain authoritative and cannot be
silently replaced. Dataset policy version and ICM checksum are checked again
at matched-cell reads, scored holdout reads and the seal boundary. V3 read
paths retain their original physical-only check to avoid revalidating all
1,326 vectors on every existing scoring call. V4 cell keys, payloads and sealed
dataset digests bind the explicit schema; omission preserves legacy bytes.
Seal and promotion reject a runtime cell carrying another policy schema.

Qualification uses the maintained isolated PostgreSQL17 runner. The added
fixtures prove independent root/wager/closed-street state expectations,
under-minimum wager rejection, malformed and blocked ranges, zero actor reach,
changed checksums and utility, a valid numerical ICM shape, cross-version and
cross-ICM refusal, canonical persisted V4 admission, and policy-key separation.
The existing V3 certification behavior and rollback/forward recovery remain
required. These are contract fixtures, not claimed solver-model qualification.

This source-only change does not activate V4. Runtime active/evaluation RPC
transport and consumer source-seal fields must explicitly carry the schema
before a V4 model can be exposed. Protected publication, exact production
installation/readback and any real model qualification are separate work.
