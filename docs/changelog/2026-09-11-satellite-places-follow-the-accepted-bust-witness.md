# Satellite Places Follow The Accepted Bust Witness

A modern satellite could award a better place to an earlier bust recorded late.
Its private settlement core rebuilt places from `elimination_sequence`, while
the cash authority already orders the accepted hands that caused each bust.

Migration `20260911204452` changes only the modern ranking block after the
combined D9 and Phase 3 manager core. Its required input body is
`6eb5860aad223fd1cfd14a48de2064bb`; its output is
`6d6637426f916cb766e606764af5e0a8`. Owner, grants, configuration, signature and
every byte outside that block are preserved. It makes no immediate data writes.

The writer selects the latest eliminated candidate per player, orders accepted
hand commit times, and uses the earliest capture of the same hand's candidates
when the commit has been pruned. Within a hand, smaller starting stacks and
then lower user IDs bust first, one microsecond apart, matching the cash
authority's existing rule. A player without an eliminated candidate retains a
finite `eliminated_at`; equal times retain the sequence and row-ID tie breaks.
Unknown or nonfinite witness times or selected same-hand stack evidence refuse
the transaction. The writer captures the entire row-to-place map once, then
writes exactly that map before the header, target manager plan or any award.

The sealed legacy branch and last-survivor winner rule are unchanged. Both
committed-header exits still return the strict public receipt before reaching
ranking or target admission. This migration cannot relabel an old paid award.
No header columns are needed: immutable awards and the existing receipt already
bind each delivered user to the awarded place; the new writer freezes that
mapping before money moves. Hand-for-hand simultaneity and split tied prizes
remain outside this ordering contract.

Verification in a disposable PostgreSQL 17.11 cluster passed 20 dynamic ranking
scenarios, including an inversion reproduced against the original block,
same-hand stack/user ties, pruned hand capture, latest eliminated generation,
rebought generation exclusion, timestamp fallback, unknown/nonfinite evidence,
sequence refusals and a one-player field. Every refusal checks unchanged roster
rows. The complete migration applied twice to the exact full core source,
preserved its catalog metadata, and refused source/configuration/grant drift.
The existing bust-order law suite passed 47 tests and TypeScript passed with
no errors. No client source changed, so a frontend build was not needed.

Run the focused statement gate with:

```sh
python3 scripts/dev/probe-satellite-accepted-bust-witness-pg17.py
```

Pass `--core-preimage /absolute/path/to/exact-combined-core-body.sql` to also
check the complete DDL against the required core. The file must contain only
the body whose MD5 is the required input above. The gate accepts no database URL
and creates its own temporary cluster with TCP disabled.

This is not qualification of the complete current settlement. The owning
integration task must still run the new core through actual fenced manager
delivery, source seat consumption, wallet/ledger settlement and deferred
certificates. Its native matrix must include three finishers whose recording
and accepted-hand order disagree, same-hand ties, a pruned commit, malformed
witness rollback, and a paid pre-migration receipt replay after the target
closes and witness retention changes. The replay must leave all financial,
roster, header, award and capability rows unchanged. Production application and
publication are outside this isolated slice.
