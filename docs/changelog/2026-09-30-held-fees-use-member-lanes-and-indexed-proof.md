# Held fee recognition uses member lanes and indexed journal proof

The installed owner operation took the global G/B exclusive settlement lane before doing any work. The first production probe on September 30 refused with `55P03` while live hands held shared G; readback confirmed no operation, basis or recognition was written and the same 741.86 remained held. Its before/after suspense checks also scanned the entire chip journal, measured at about 28 seconds each. Neither a longer wait nor a global pause is required for these completed, non-satellite events.

Forward migration `20260930121356` replaces only `fn_ca_recognize_held_tournament_fees_by_owner_basis(uuid,jsonb)`. It pins the installed full definition `ca906b422c26f10d1288a4fcc165c0f1`, the existing member-lane/provenance helpers, and the ready settlement index/enrichment trigger. It acquires the existing non-satellite member lane in deterministic event order, then re-enters each member before its unchanged canonical rake payer. The global/finish helpers, payer, rates, recipients, player payouts and terminal evidence remain unchanged.

The existing settlement and correlation context tags every operation journal entry. The existing settlement index bounds verification to this operation: exactly one canonical union-wallet or standalone-retirement leg per listed event, exact event/host/receipt/amount provenance, no extra entries and no suspense entries, even a zero-net pair. Union journal destinations identify the `union_wallets` row, whose `union_id` is checked separately. Existing escrow, recognized-source, prize, replay, authorization and append-only checks remain. The function restores all nine inherited ledger context values it or its nested payer changes.

The receipt's `settlement_suspense_net` is now the operation's verified zero suspense movement, not a scan of the entire estate. `journal_rows` and `journal_settlement_id` make that scope explicit. Future operation/basis rows accurately record an agent decision dated September 30 under the owner's delegated financial repair authority; they do not attribute an unverified historical quote or a chosen commercial rate to the owner. No existing record or installed migration is rewritten.

## Validation

The maintained native owner-basis runner now invokes the new regression in its existing required accounting phase. It retains the original Early Bird 2.70 and an original standalone Spin 0.24, with explicitly synthetic account/agreement support. The added original scene rolls back completely before the existing weekly-accounting assertions.

- Installed global request refuses under an independent backend's shared G, with a byte-identical financial snapshot.
- Full-definition drift refuses migration atomically, preserving schema and ACL.
- The replacement settles both events and their distinct journal shapes while shared G remains held.
- Wrong correlation, a balanced extra suspense pair, and an orphan operation-tagged journal each refuse and roll back all effects.
- Inherited ledger context restores; repeated and altered multi-event requests preserve idempotency.
- All 34 original owner-basis assertions pass, including authorization, missing terms, append-only records, conservation, replay and the normal weekly readers. The added regression executes 13 assertions including four reused original-scene checks.
- The current payer's one-line shared accounting-week lock successor is captured and qualified; no common financial function is modified by this migration.

Local command: `bash scripts/dev/test-full-weekly-accounting-activation.sh --held-fee-owner-basis-only`. Exact native result: owner `postgres`, ACL `{postgres=X/postgres,service_role=X/postgres}`, unchanged search path/120s statement/5s lock settings, replacement full-definition MD5 `a98b0abf8846c15db828006d40cb60df`. Source binding verification passed 780 pins. SQL files were reread and `git diff --check` passed. No TypeScript source, dependency or compiler input changes in this repair.

This is isolated qualification, not a production payment. Protected integration, exact installation, the root owner's self-aborting probe using the existing operation UUID, one committed operation and persisted readback remain separate delivery gates. The production cohort is 18 events totaling 741.86; the two-event fixture is not a claim that production has been settled.
