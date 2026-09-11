# Final-table deal tails bind the accepted bust witness

D12 requires final-table deals to use the same eliminated-player ordering as ordinary settlement. The phase-three v2 writer normalized that tail by `elimination_sequence`; its verifier required that same recording order. The exact-consent snapshot bound roster sequences and current hand maxima, but omitted the accepted bust witness. A late-recorded bust could therefore change the recipient of a fixed tail prize while every existing deal check passed.

The additive migration `20260911204238_final_deal_tail_binds_accepted_bust_witness.sql` changes the actual writer, verifier, and consent snapshot. It adds an owner-only, stable witness reader called by both snapshot and writer. It selects the latest accepted `state='eliminated'` candidate using the same hand-number/id rule as ordinary settlement, uses its committed-hand timestamp, uses the first same-hand candidate timestamp if the commit was pruned, and otherwise retains the accepted `eliminated_at` fallback. Same-hand busts use the existing stack/user ordering and microsecond offsets. Final ties retain sequence/id ordering. It does not rewrite elimination sequences.

New v2 batches carry immutable `rank_basis='accepted_bust_witness_v1'` and the full `bust_tail_snapshot`. The existing batch freeze covers both added fields. The proposal hash binds the same witness inputs and proposed tail positions; an old or changed witness requires a fresh proposal and consent. Active shares and active final places remain ranked by chips, registration time and user id. Paid replay verifies stored witness positions, so routine commit pruning cannot change a completed result.

Existing batches receive the metadata default `recording_sequence_v2` with no witness snapshot. Their original historical fields, money rows, stored proposal, execution, and terminal receipt remain unchanged. The verifier retains their recording-order contract. In particular, a paid old batch with accepted-hand evidence contradicting its recorded positions still replays its exact original receipt.

The writer retains all financial mismatch refusals. An unfinished event whose old tail recipient has already been paid contrary to the newly witnessed entitlement raises `P0404: has payout evidence outside an exact fixed-place entitlement` and rolls back every change. That event requires the already-authorized D8 reconciliation/disposition before completion. This package does not claw back chips, pay make-goods, rewrite paid receipts, or mutate any event.

## Native qualification

`docs/audits/2026-09-11-final-deal-bust-witness-native.json` records 20 passing scenarios and 611 passing native assertions. Five scenarios expect migration refusal for function body, ACL, configuration, helper, or rank-constraint drift. Every scenario proves exact outer rollback across the affected catalog rows and all available tables in the 29-table financial/application scope. The actual terminal probes also compare every financial, custody, proposal, capability, lifecycle and witness row across the late failure and replay.

The successful paths run the actual phase-three consent, payout, escrow, rake, finish-claim, terminal-certificate and per-seat capability functions with all seven tournament guards enabled and `session_replication_role=origin`. Synthetic opening fixtures alone establish prior balances and old receipts. No fake money or terminal authority is installed.

Covered cases:

- Paid, unpaid and partially paid prior fixed prizes; exact migration reapplication.
- Paid v2 upgrade, including a paid recording-order result contradicted by its bust witnesses; all old values preserved and exact receipt/direct-writer replay.
- Open pre-upgrade consent refused without modifying its immutable proposal or paying chips.
- Reversed recording/commit order; same-hand unequal and equal starting stacks; pruned commits; no-candidate fallback; newer rebought candidate ignored.
- Pruning a commit after a newly witnessed deal was paid; exact replay remains unchanged.
- Witness drift after unanimous consent; old proposal cannot execute.
- Prior wrong-recipient payment; atomic refusal without clawback or second payout.
- Function-body, ACL, configuration, helper and rank-schema drift refused by the additive migration.

Each successful terminal path preserves the original 100.00 pool: 5.00 fixed entitlement plus 95.00 live deal shares, zero residual custody, and five minted/consumed seat capabilities. The late terminal-receipt failure rolls back all these effects. Both new batch fields reject post-payment mutation.

The existing `a-final-table-deal-pays-every-share-or-none` and `a-bust-is-ranked-by-when-it-happened` Vitest suites passed all 60 tests. The native law is registered at `tests/a-final-deal-tail-binds-bust-witness.law.test.py` and accepts explicit local fixture coordinates:

```sh
python3 tests/a-final-deal-tail-binds-bust-witness.law.test.py \
  --socket /tmp/codex-accounting-deal-witness-socket --port 55487 \
  --output work/deal-witness/native
```

The owned PG17 fixture was copied read-only with `pg_dump` from the retained `full_stage1` fixture. Restore exposed an existing synthetic baseline foreign key whose one legacy member row lacks a profile; the same foreign key was restored locally as `NOT VALID`, preserving enforcement on all new fixture rows. No source fixture was changed. `scripts/ci/rehearse-final-deal-current-terminal.py::compose` supplies the already-qualified current runtime foundation. The initial broad all-catalog checksum spilled temporary sort files into the nearly full local volume; final evidence uses bounded affected-catalog checks and sequential aggregates. It does not treat that interrupted run as acceptance.

## Integration order and remaining dependencies

1. Compose/activate the reviewed current phase-three terminal, private payer, exact-consent and seven-guard contracts first. This migration requires their exact function bodies, roles, ACLs and configuration. It does not activate phase three.
2. Integrate updated source pins and schema expectations in the parent-owned activation/readiness tooling, then apply this migration under the existing authorized release procedure. The migration takes the established global accounting lane before its bounded DDL. It adds no lease or maintenance protocol.
3. Treat open old proposals as stale and let the normal review/consent flow create fresh proposals. Preserve paid v2 history and replay it through its existing authority.
4. Identify already-paid contradictory tail entitlements read-only and preserve the D8 prerequisite. This package has made no production query or financial mutation.
5. Rerun the composed native release qualification and verify installed function/column/constraint identities. Wiring this retained-fixture native law into the parent-owned CI/cutover composition remains integration work; a local run is not an installed production proof.

Exact function body pins:

| Function                                               | Required before                    | Installed after                    |
| ------------------------------------------------------ | ---------------------------------- | ---------------------------------- |
| `fn_ca_tournament_deal_snapshot(uuid)`                 | `6eee1f2e33f6a62bbc0dd59086c98c1c` | `8d2859e2f97bab394a8e976393a9c9f7` |
| `fn_settle_tournament_final_table_deal(uuid)`          | `b1941b2e55dade307ecd74068ab3e500` | `90985f9be4b5bf29187e0d7e33170c16` |
| `fn_ca_verify_terminal_final_deal_batch(uuid,boolean)` | `260c94b41d7f2bb021a88a546a1714ac` | `61c144f02104b769fc3b8bc583df2950` |
| `fn_ca_final_deal_bust_tail(uuid,integer)`             | absent                             | `fb5532b69509567df6bdd339594f95c2` |

Migration SHA256: `96fa19d9bf44bc5ebb141dc6a16cf65af21f20b6cc3a29adc8fbd2c85a679b76`. Prepared on canonical Club Arena `origin/main` base `11a3730678`. No applied migration history, activation script, World Hub, controller, lease, maintenance, Horse or Trivia file was changed. Nothing was pushed, published or applied to production.
