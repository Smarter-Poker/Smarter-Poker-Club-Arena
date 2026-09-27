# Ordinary elimination takes its canonical lane before row locks

The installed ordinary elimination RPC locked the tournament and player rows
before its F06 source trigger tried the canonical tournament lane. An accepted
hand in the same event can hold that lane shared. The late promotion then
refuses with `40001 F06_RETRY_CANONICAL_LANE`, leaving a proven zero-stack
candidate pending. Another replay can hit the same conflict.

The public RPC now takes the existing G-shared/T-exclusive canonical prefix
after its original argument validation and before its first row lock. NULL
identity retains its original refusal without requesting the global exclusive
lane. Removing this prefix reproduces the complete captured function exactly.
The migration guards all five current authorities, their ownership/config/ACL,
and both enabled F06 source triggers; those authorities and financial predicates
are unchanged. The existing engine API uses the corrected function directly.

Native PG17 qualification composes the full maintained financial catalog,
actual accepted-hand/settlement/candidate fixtures and current installed F06
source guard. The unchanged historical 98-assertion transaction probe and the
current-authority 98-assertion probe both pass. The latter records the already
installed permission for claimed premanifest custody with no movement admission.
It does not relax a source guard. Both probes roll back all public/private state.

Two real sessions reproduce the original late-lane refusal with commit and
rollback of the hand owner. With the candidate, the complete claim waits at its
advisory lane, while the holder can still acquire the tournament row NOWAIT.
After either hand-owner outcome, the claim completes once, its exact duplicate
is idempotent, source custody remains unchanged and no financial transfer is
invented. Four additional original ordinary/PKO duplicate races pass. Four
source/ACL/trigger/lane drift cases refuse installation with complete rollback.
Result parsing has negative cases for missing waits, absent proof, errors,
wrong scenario, transport failure and absent completion.

The first local invocation lacked the real hand-lane helper in its isolated
fixture and failed before reproducing contention. The fixture now composes that
exact installed helper from its read-only capture. No production change was
made by either native run. Required accounting PostgreSQL shard 3 executes the
native qualification and retains its output whenever any input changes.

Production installation, original candidate/backlog progress and protected
source publication are distinct remaining evidence. Four zero-stack players
on the selected Morning FreeBuy table have exact durable zero hand/settlement
receipts, but finishing places must still follow the complete event's original
candidate order. This change does not edit those registrations, positions or
receipts, nor weaken the whole-roster movement guard. The two older selected
stalls have coherent rosters and are a separate diagnosis.

Installed once as20260927170836 at17:08:36UTC; exact10,651 SQL bytes SHA25603f7fa6f15b64ff309a5982a3f845cb36664a0843e0e781a85f3940b0e1178f5 match durable history. Readback17:08:57 keeps originalOID24464413 and authority with qualified postdefinitiona5585b9d7fb061f12c29f1262a5a1b6c. File renamed to actual provider history without changing SQL. Installation did not invoke an elimination or rewrite any player record. Natural backlog progress remains a separate acceptance item.
