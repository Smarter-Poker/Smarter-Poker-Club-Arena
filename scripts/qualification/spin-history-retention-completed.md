# Captured completed-Spin receipt eligibility

Source only; not executed. This is a finite extension of the existing Spin
PostgreSQL qualification, not another runner or a financial lifecycle fixture.
The accepted seven-case retention v2 packet remains byte-for-byte unchanged.

The original preimage and candidate must both prune exactly one old synthetic
horse-only history projected onto a completed Spin with an authentic captured
terminal receipt. They must leave that entire receipt and every other restored
row unchanged. Each pruner image and the whole projection must roll back exactly.
This control establishes receipt eligibility only. It does not establish terminal
creation, historical payment reconciliation, genuine paid entry/gameplay, the
original alert's 22-member cohort, or any missing historical hand.

## Input and provenance

`fixtures/spin-history-retention/completed-start-authority.json` is the original
read-only repeatable-read capture at 2026-09-17 07:35:54.523723 UTC. Its SHA256 is
`34e390830fe89c997d61d9966398f01f6bef942db628c600a54ed8b9c901d30c`.
`capture-completed-start.sql` is its bounded SELECT source; only its UUID-handling
comment was corrected after the approved original-identity decision. The exact
executed earlier query remains in the raw capture and frozen v1. The result reports a
complete 9,030-byte packet with one tournament, table, club and terminal receipt,
two minimal auth identities, one minimal profile and no union. No current value
or receipt is created by that capture.

`completed-start-input.sql` carries the complete original terminal receipt as
JSONB, with original UUIDs and all original values unchanged. The SQL assertion
compares the complete persisted row to that JSONB. This is value equality after
typed restoration, not a claim about JSON whitespace or PostgreSQL heap bytes.
The original raw artifact remains separately pinned. No payment success field,
hash, winner, rank, closed table/seat identity, amount or receipt time is generated
or rewritten.

The club, tournament and table are deliberately **narrow logical projections**
of the captured parent rows. Captured fields must read back exactly; omitted
administrative fields use the genuine provider defaults, and names are synthetic.
Five uncaptured and unused club fields (`chip_treasury`, `chip_pool`,
`promo_balance`, `insurance_balance`, `total_rake`) are explicitly seeded and
asserted zero as **synthetic fixture input**. This avoids inheriting the schema's
100000 treasury default. These values do not assert the real club had zero funds,
and no minted/funded balance or balancing journal is manufactured.
Their `source_row_md5` values identify the captured source rows and are never
claimed to equal the projected fixture rows. This is not a full financial restore:
wallets, journals, escrow, payouts, obligations, roster and seats remain empty.
The only needed auth/profile FK is the already existing zero-balance provider
owner. The receipt's winner/seat UUIDs have no additional FK in the captured
schema, so no production player, credential or contact data is imported.

## Existing-runner composition

Use a **separately disposable logical-fixture database/cluster within the existing
Spin runner's admitted allocation**, with its existing no-network, time, resource,
source-binding and cleanup controls. Do not extend deadlines silently or introduce
a workflow/job. This new branch is not yet wired or executed. It cannot be put
directly into the seven-case/funded database because the imported immutable receipt
and completed parents intentionally persist as starting input.

1. Use the exact existing schema split before its first user trigger. Restore the
   authentic schema prefix and the existing synthetic principals with all real
   constraints/defaults/FKs/indexes. Do not execute the signup/Mint path.
2. On a fresh `fixture_bootstrap` session with the existing execution GUC and
   `execution_uuid` variable, run `completed-start-restore.sql`. It refuses user
   triggers, nonempty non-principal relations, FK drift, wrong socket/database/role
   or version. It inserts only the four starting rows and commits that logical
   input. The terminal receipt is the authentic captured row, not a fabricated
   success fixture. The source file has its own transaction; do not nest it inside
   another transaction or assume the existing principals' commits will roll back.
3. Install the unmodified remaining schema trigger suffix, access, policies and
   the existing scoped provider supplements. Run the complete existing provider
   checks, including retention `provider-supplement.sql`, `provider-check.sql` and
   `provider-closure-check.sql`. All real triggers must be enabled before the
   history writer or pruner is invoked. No replica role or disabled trigger is
   permitted. The ordinary empty-business-state gate must run before this branch's
   input restore, or be replaced **only in this separate branch** by its exact
   four-row input and zero-ancillary assertions; do not weaken the funded gate.
4. On a fresh ordinary non-superuser `postgres` session, pass the existing
   `execution_uuid` and `ordinary_user_uuid` variables and execution GUC to
   `spin-history-retention-completed.sql`. It rebinds the exact receipt and parent
   projection, calls the actual horse social trigger and owner history writer for
   one explicitly synthetic old zero-money late projection, then calls both real
   pruner images. No terminal/payout/finish function is called.
5. Require the exact final qualification result, plus ordinary backend retirement
   and whole logical-fixture database/cluster disposal. The projection's outer
   rollback restores the logical starting rows, **not an empty database**. Never
   DELETE-clean immutable receipts, disable their guard or reuse this database
   for the funded fixture. A timeout/disconnect is unknown until normal backend
   cleanup and disposal have been proved; no successful receipt may be inferred.

All child processes must return actual exit success; the existing runner must
bind staged files/includes and collect a durable result before recording success.
This source packet alone does not provide that runner integration or proof.

## Exact assertions and limits

The consumer uses the v2 full-row state oracle (at most 400 restored relations,
1,000 rows each and 4 MiB total). It independently permits removal of the one
generated history ID only from the four existing pruner deletion targets. It
requires one removal in both preimage and candidate, exact full-estate equality
after pruning, and exact row/catalog equality after each rollback. The canonical
receipt is compared in full before and after the real projection and included in
every full-estate comparison. Actual deferred constraints run before pruning.

The generated history is not a successful hand receipt: no canonical atomic,
legacy settlement, postcommit outbox or pending knockout row may appear. Its
synthetic horse and zero-money state are explicit. Wallet/journal/mint/payout/
obligation tables must remain empty, and provider profile balances remain zero.
Actual sequence advancement is observed and disclosed; counters are never reset
or claimed transactional. Pre-trigger table defaults can also advance genuine
lifecycle sequences before the consumer's observation. Whole disposal contains
those advances.

Expected result: qualification `spin_history_retention_completed_receipt_eligibility`,
`old_deleted=1`, `candidate_deleted=1`, `captured_receipt_unchanged=true`,
`projection_and_catalog_rollback_verified=true`,
`starting_estate_retained_until_database_disposal=true`, and explicit false flags
for terminal creation, financial lifecycle and multisession race qualification.
The observed source time must equal the pinned capture. No final result exists yet.

A completed/terminal transition commit-versus-rollback race remains unqualified.
This already completed starting state cannot honestly manufacture that race.
The accepted seven-case packet separately uses genuine zero-entry cancellation;
played-history cancellation is not a valid race because the real cancel guard
refuses preexisting histories. No additional economic program is authorized here.
