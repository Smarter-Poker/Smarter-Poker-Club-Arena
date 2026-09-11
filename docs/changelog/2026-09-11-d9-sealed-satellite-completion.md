# Legacy satellites settle from sealed accepted hands and published terms

Three legacy satellites had already finished their hands while their tournament
rows still said REGISTERING. They had no historical start-time economic snapshot
or modern entry-close receipt. Treating a present-day snapshot as historical
authority would misstate their history.

The additive completion path seals the exact accepted-hand standings and original
published source/target terms, checks that all economic dimensions still agree,
and invokes the existing canonical satellite settlement authority. The separate
receipt explicitly labels its economic evidence as a current reconstruction of
published terms. It never manufactures an old start or entry-close snapshot,
changes historical elimination order, or alters prior payments.

A native check caught the existing start trigger taking a fresh snapshot during
the transient REGISTERING-to-RUNNING recovery step. That trigger now recognizes
only the exact same-transaction private seal and unchanged source row for this
step. The seal's deferred guard requires complete certified settlement in the
same transaction. A caller-supplied recovery hint cannot bypass the ordinary
launch guard. All ordinary start-trigger logic remains intact.

The three events each return one 20.00 cash ticket and an 8.50 second-place
remainder through the existing rules: 85.50 total payouts and 4.50 total rake.
The strict modern satellite receipt function remains byte-identical. Migration
preflight pins its complete definition, postgres owner, definer mode, fixed path,
timeout and private execution ACL. The unchanged public wrapper is likewise
pinned to its exact existing postgres/service_role contract. A typed
preterminal verifier is private and accepts only the exact current sealed finish
claim; the final certificate is issued after deferred checks, source-table/seat
closure and exact accounting proof. Every new helper is inaccessible to anon,
authenticated and service_role callers.

Fresh native PostgreSQL 17.11 validation:

- Repeated the committed 21-event cash fixture, then rebuilt E2 from its original
  uncompleted snapshot. Installed every satellite replacement before the original
  11 hypothetical future busts and ordinary terminal call. That post-migration
  completion paid 304.00 in 17 places, matched all 167 ranks, preserved 155
  historical elimination records and replayed unchanged without a legacy seal.
- Completed all three satellites, verified all 30 compared tables, preserved
  historical amounts/times/null sequences, and proved unchanged terminal replay.
  Independently checked every recipient's actual club chip-balance increase,
  totaling 85.50, and unchanged balances for all other users.
- Passed 23 negative cases, including changed terms/source, forged or incomplete
  seals, missing awards/remainders, failed seat/table closure, altered evidence
  before deferred checks, forbidden role calls and the unsealed launch hint.
- Six additional native installation probes changed the strict verifier body,
  owner, grants or configuration, or the public wrapper body/grants. Every exact
  migration attempt refused before replacement and rolled back all changes.
- All seven D12 accounting guards remain enabled. The actual ordinary capture
  trigger also passed an isolated temporary-row test; no canonical launch guard
  was disabled or a launch receipt fabricated for that test.
- The disposable cluster stopped after the run. No production writes occurred.

Reproduce with `python3 scripts/ci/rehearse-d9-satellite-completion.py` and an
installed PostgreSQL 17 toolchain (`--pg-bin` is supported). The runner verifies
its immutable fixture and migration hashes, creates only local databases, and
records exact native receipts. Production application remains a separate serial
operation requiring fresh exact-source and preserved-history checks. The three
revived-player events, one winner-chip mismatch, eleven genuinely unfinished
events and one additional paid-history case remain separate dispositions.

The ordinary E2 probe tests the real modern cash terminal path and all affected
tournament completion guards after this migration. Its future hand outcomes are
explicit local fixtures. It does not claim a new ordinary satellite was launched
and dealt, or that browser/engine production behavior was tested. The ordinary
start trigger has only the separately labeled temporary-row regression here.

Final source pins: migration SHA256 `537b9076099a68561783a7a9714acb4c86f99543a9fc976332490e7d2ecfa133`; fixture archive SHA256 `6348a41f1f03250d0196bbf8ac18cee4cd4d5bf8214d45620a68bcd34ef29145`; raw fixture manifest SHA256 `7b8aa1f946e7fc86ea046ad5d915c11741b340df12a6081dab0a2075041a9b72`. These supersede the earlier d97d915f migration and c8a2eccf archive proof. The native receipt records the runner hash and exact dependency metadata.
