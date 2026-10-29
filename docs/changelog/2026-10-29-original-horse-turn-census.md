# Compare original committed horse turns with their retained decision evidence

The existing private fleet observer gains a closed control-only `fleet-turns`
mode. Its denominator comes from a bounded, indexed, read-only database snapshot
of the canonical 1,000 identities and each selected committed hand's public
action ordinals. Classic actions must agree with the original accepted request;
Lightning coordinates retain their accepted receipt's original lease.

A commit window owns a hand's whole original journal. The earlier observer
selected by commit time but rejected decisions preceding that window, leaving
boundary-crossing hands unrecoverable through disjoint window unions. Historical
ledgers are preserved rather than regraded.

The new sanitized ledger retains expected actor indices, hashed original hand
keys, streets and full action ordinals even when capture is missing. Original
binding, execution, selected-action agreement, canonical input/read-frame
binding, historical-read availability and phase applicability stay separate.
Disjoint same-source/cohort windows can combine without double counting; source
changes, overlap, omissions and contradictory evidence are refused.

The existing read-only, network-isolated observer retains its image/serving
identity checks, resource limits and cleanup. No cards, raw captures or actor
identities leave it. This adds no policy, engine activation, forced play or
qualification flag. Input binding is not a strategy-correctness guarantee, and
a finite observation cannot certify all future hands. Missing or unavailable
history remains explicit. Required regression coverage includes actual journal
modules, transport privacy/isolation and an isolated PostgreSQL census fixture.

The existing private provider job selects this census only for an explicit JSON
boolean `turn_census: true`; absent/false retains the existing observer. Its
protected sparse checkout includes the three maintained control modules. Release
jobs, concurrency and activation remain under their existing owner.

Required-check recovery: the integrated PostgreSQL shard exposed two inherited
commerce fixture INSERTs still drawing a random five-digit club code. One
collided with an existing club and blocked census-control qualification. Both
synthetic inserts now use the fixture's existing locked max-plus-one allocation.
The existing native completion regression holds the default at an occupied code
while exercising the inherited scenarios, covering both recreated and union-shell
clubs. Captured schema, production defaults and commerce assertions are unchanged.
The regression reproduced the collision before the correction and passed after it.
