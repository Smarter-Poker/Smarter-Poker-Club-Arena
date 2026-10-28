# Historical own playing earnings and typed weekly receipts

This is maintained source qualification, not production installation or payment evidence.
The reserved migration is `supabase/migrations/20261028184531_own_playing_agent_earnings_keep_typed_wallet_receipts.sql`.
It changes 15 existing owners and adds nine private owners, five immutable cold
sidecars and an effective tournament-fee view. `source-binding.json` records
all exact function preimages/postimages and the maintained SQL SHA256 inputs.
`build-migration.py --check` enforces the generated migration against those files.
For a maintained source edit, native `--compile-fragments` emits compiler body
identities for `build-migration.py --bootstrap-postimages PATH`; then run the
default whole-installer native mode. Compiler mode does not qualify installation.

The original earning constructor omitted the earning agent's own historical
agreement. The corrected constructor uses that agreement first. Its explicit
direct-owner 70% exception remains unchanged. Ordinary agent playing earnings
therefore enter the original commission stage as AGENT earnings with zero
additional PLAYER entitlement. When one original payer funds historical PLAYER
and later own-agent 70% earnings in one period, the original aggregate payer
cent plan is partitioned into two destination legs. AGENT ledger identities use
the user UUID and the canonical BUSINESS wallet transaction alias.

Existing raw sources, paid certificates, original payer transfers and the v3
ABI are retained byte-for-byte. New destination contracts and receipts use
sidecars. Original paid R0/R2/R3 and producer capture/recognition replays stay
legacy and never admit or mint an own-agent delta, including when a canonical
approved manual correction already exists. No payment is executed by installing
this migration. Historical corrections are a separately owned operation.

The original unpaid R0 request owns interpretation and bounded progress. It
records the complete original raw source and contract, original pending
commission rows, and original invalidated cache/certificate hashes. Only a
certifiably unpaid scope can receive this version. It then invokes the original
commission posting owner. New R2/R3 refuse an incomplete interpretation.
Source IDs are limited before historical evaluation; immutable review receipts
also retain unchanged results, so every bounded request makes durable progress.
The original preparation caller continues only this explicit positive-progress
result within its existing 30-second/scope/due boundary. Each source checks that
same physical deadline; unrelated errors and refusal results stop immediately.
There is no periodic repair worker, synthetic history invalidation, GEN retag,
paid-certificate rebuild or source rewrite. Current active and suspended agent
wallets receive historically earned amounts; frozen/missing/ambiguous new
own-agent destinations refuse. Existing deleted-profile discharge is preserved.

## Integration and installation

The three R2/R3 source files compose every exact owned-pause patch from
`pause-owner-patches.json`. The migration requires installed history
`20261028162126` and all three exact postpause preimages and the exact original private preparation caller. Preserve that dependency
when integrating the protected pause PR. The native suite also consumes the
maintained actual document pipeline from the protected earned-commission helper
followup. External source-root flags are for coordinated local qualification;
CI defaults use only this repository's protected dependency sources.

The migration declares `daily-maintenance` because its new AGENT-only deferred
constraint trigger takes a writer-blocking lock on `chip_ledger`. The original
PLAYER trigger predicate remains unchanged. No sidecar has a foreign key to a
hot game, club or wallet table. Root owns production installation and financial
operations; protected merge is separate from installed/live proof.

The changed owners have zero direct intersection with the original 65 source
inventory. The actual 245 restoration cases contain zero function-reference
entries; their six migration-source entries reference only immutable migrations
20261007024455 and 20261007132839, which this change does not modify. The actual
reference reader does not traverse these changed owners. Thus the original
65 match function and GEN `original-inventory-245-v1:72b51e4349fc9cd371bfb7f771b7ae20`
remain unchanged. Installation asserts those original authorities before and
after DDL. No tournament-quality owner is changed.

## Focused native proof

Run PostgreSQL 17 on an owned external scratch directory:

```sh
python3 -B scripts/ci/test-own-agent-rakeback-postgres.py --pg-bin "$PG_BIN" --scratch "$OWNED_SCRATCH"
python3 -B scripts/ci/test-own-agent-financial-postgres.py --pg-bin "$PG_BIN" --scratch-root "$OWNED_SCRATCH" --output "$OWNED_SCRATCH/own-agent-v1.json"
python3 -B scripts/qualification/own-agent-v1/build-migration.py --check
```

The existing `test_launch_reset_floor.py` invokes both native scripts in the
required accounting CI shard. The financial test installs the whole candidate,
checks exact metadata and live-proof predicates, rejects replay and rolls back
injected dependency/GEN/preimage/postimage faults. It runs real original
commission and rakeback stages, selected real ledger and document triggers,
actual immutable/invoice/delivery/launch/fee/terminal/freeze owners, and the
canonical approved commission helper. The former `wcs_receipt` substitute is
absent. These noncashout invoices are numbered history-only receipts; they do
not create Messenger messages or notifications.

Acceptance includes original paid three-scope five-hash/six-header/raw-source
and certificate preservation, no delta after manual correction, old cash and
recognized-fee producer replay, genuine unpaid cash/fee R0 through R3, same-payer
mixed destinations, suspended status preservation, original append-only audit,
256-source bounded R0 progress, an actual historical-call counter over 1,025
mixed eligible/unchanged sources with no repeated work after completion, bank
shortfall, malformed/mutated source and
commission refusals, missing phase and private-role denial. JSON output records
all source input SHA256 values and exact postimages.

Full-week source prerequisite readers, fleet certificate/clock, and unchanged
original inventory authorities are explicit controlled isolation boundaries in
the native fixture. This does not certify production capacity, actual fleet
parking, current paid-book catalog state, installer timing or live delivery.
The separate focused pricing proof covers six synthetic source roles and
historical promotion, including the preserved owner70 exception.
