# Snapshot retention bounds eligibility work

October 27 job119 repeatedly timed out inside `horse_snapshot_disposable`.
The age filter correctly avoided young snapshots, but LIMIT applied after
the expensive disposal predicate. Millions of old retained witnesses could
still be checked before finding one deletable row, rolling the entire call back.

The existing retention transaction now takes a bounded candidate page before
eligibility and advances a private scan position atomically with its deletes.
The next call continues past retained rows; after the pass ends it revisits
them so an original hand resolving its custody can release its witness.
The authoritative disposal function, eight-day rule, human history, BBJ,
escrow, certificate and interrupted-hand holds are preserved. No new schedule
or repair job is introduced. The private scan table has no live-table foreign
key and no public/service grants. Concurrent callers skip the locked cursor.

Native PostgreSQL regression captures the exact production preimage and
demonstrates unbounded baseline eligibility calls, bounded pages, retained
human witnesses, progress to later eligible rows, pass wrap and revisit,
atomic cursor/deletion rollback, preserved function identity/ACL and refused
migration replay. The existing directly triggered retention workflow runs it.
The eligibility stand-in counts calls; it does not certify every production
disposal dependency. Production installation and timing evidence are separate.
