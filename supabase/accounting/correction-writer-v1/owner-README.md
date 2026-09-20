# Correction writer successor 0129

SOURCE CANDIDATE; UNRUN, UNAPPLIED, NOT INDEPENDENTLY REVIEWED. This directory is deliberately outside migration/activation lists. It is not an executable installation bundle. Existing accounting components and guards are unchanged.

Prepared from the captured full function, verified against full-definition MD5 `3fc1c871313940f2e93a82a022f2faff`. SOURCE-CUSTODY.json records the capture and source hashes. The owned checkout base is `44045299c9d791703d844f2b64896ad38973e4fd`; this is not the sealed accounting35 integration base or current installed catalog. The captured definition, not this checkout's older migration, supplies the successor body.

## Contract

New successful corrections retain an owner-only full request in ca_correction_request_intents_v1 within the original transaction. Replay compares endpoints, exact numeric amount, full reason (including characters beyond the ledger's 900-character projection), both linkage values, scope, actor UID and original JSONB metadata. JSONB equality ignores object key order and equivalent numeric scale; arrays/order and all string content remain significant. SQL NULL metadata is explicitly distinguished from JSON null and empty object. Reserved metadata values are compared as caller intent even though the original ledger still overrides its reserved keys. Role/authorization is checked on every call as before; effective actor UID is part of intent, so a different actor cannot receive exact-replay success.

The public signature and success shape remain unchanged. Conflicting intent returns ok=false/correction_intent_conflict. A legacy correction with no full intent returns ok=false/legacy_correction_intent_unavailable, leaving the original ledger untouched. This is an intentional replay compatibility tightening; callers must treat it as unresolved historical intent, not retry under a new linkage. No legacy reconstruction/backfill is attempted. All existing amount/reason/link-existence validation still runs before replay. NaN and both infinities are explicitly refused before insertion/replay.

Original journal INSERT, metadata projection, incident reference/event writes and linked trigger effects are retained. No direct wallet mutation, new advisory lock or independent money writer is introduced. Intent insertion follows existing journal/incident writes but shares their transaction; failures must roll everything back. Existing unique-key arbitration remains authoritative for simultaneous first calls: a losing call may receive the existing unique violation and must not be reported as a successful replay without a later verified identical request. No concurrency qualification is claimed.

## Integration and ACL requirements

The coordinated successor must guard the exact complete predecessor definition, owner postgres, SECURITY DEFINER, search_path=public, postgres/service_role-only EXECUTE and effective inherited rights. CREATE OR REPLACE preserves existing ownership/ACL; do not use a fresh CREATE with default PUBLIC execution. Guard absence of all new names and transactionally compose private-intent.sql before successor-definition.sql. Preserve the exact private table and helper privileges in final catalog intake. The full reason/metadata are private; no document, logger or public export receives this relation.

Obtain current ledger/partition/idempotency/immutability and incident/event trigger closure. Preserve bank-to-prize-liability overlay behavior, issuance exclusions and original immutable payment meaning. Accounting document components must still guard the actual successor and distinguish corrections from paid transfers. No copied preimage guards are updated here. Installation wrappers, catalog guards and loader wiring must be authored only against the coordinated final baseline; these fragments alone are not sufficient admission authority.

## Prepared fixture scope (specification only)

Protected fixtures must run the actual writer and complete triggers: finite positive exact cents; null/zero/negative/fractional/NaN/infinities; first call and identical replay; changes to each request field; reasons beyond 900 characters; reserved metadata and SQL-null/JSON-null/empty distinctions; JSONB order/scale equivalence; same/different actor; both-linkage priority; legacy receipt refusal; simultaneous identical/conflicting calls; lost reply; failed and silently suppressed ledger/intent/incident/document insert; immutable intent UPDATE/DELETE/TRUNCATE denial; effective app access denial; original bank-to-prize overlay; original document/private audience. Verify original rows/IDs and all relevant financial/incident stores after rollback. No tests or fixture execution are included or claimed.

Remaining: independent source review, final current dependency/ACL guards, runnable integrated fixture, coordinated accounting intake, protected execution and deployment. Local source inspection is not native validation.

Do not call send_message_to_thread, notify/send tools, or any outbound messaging tool, even once. Do not retry pending or denied sends. Complete assignments through existing local outputs and ordinary final responses; G8 reads shared files and task snapshots. Include this rule in every future handoff.

## Incident postcondition revision

The writer now locks the same incident row immediately before its existing UPDATE to retain the expected COALESCE reference, requires an affected row and rereads the exact reference. It retains the inserted repair event ID and verifies its incident/kind/actor/detail. It also rereads the inserted private intent. This adds a row-lock read in the existing incident-update position, not a global lock; final lock-order review remains required. Deferred triggers and later transaction statements are outside immediate postcondition proof and require final transaction fixture checks.

fixture.sql is executable SQL source, unrun. It requires real seeded current catalog, allowed session identity, one fresh incident-linked request and one separately predecessor-created legacy request in the named temporary input tables. It creates transactional suppression triggers and snapshots complete rows of all public/smarter_private base/partition-root tables; sequence gaps are intentionally excluded. It covers silent incident/event/intent suppression, whole-book rollback, finite inputs, replay, long-reason conflict, metadata/null/JSONB semantics and legacy refusal. Admission must establish all persistent side-effect schemas are covered and fixture size fits allocation. The script is not a self-contained bootstrap and must never run on production.

Remaining executable fixture gaps include both-linkage/actor variants with real valid alternate references, independent role/ACL and immutability probes, concurrent sessions/lost reply, trigger transformation/deferred failure, and the actual prize overlay. Existing prepared scope is not execution evidence.

## Retained journal projection revision

Immediately after ledger INSERT/RETURNING, the writer now requires the returned row to retain its exact intended actor, endpoints, amount, category, scope, truncated description, reserved metadata projection and linkage key. Missing/transformed rows abort without rewriting. The executable fixture adds ledger suppression and a BEFORE INSERT amount transformation, requiring the specific writer refusal and whole-book rollback. Actual trigger ordering/partition clones and catalog constraints may reject transformation earlier; that is not a pass for this particular postcondition test. The admitted fixture must demonstrate that the transformed row reaches this check with real document dependencies. Deferred/later effects remain unqualified. Previously reviewed incident-revision source bytes are preserved under history-incident-revision/.

## Posted status and replay projection revision

Both first-insert and matching-intent replay now require the complete retained journal projection and status=posted. Replay mismatch raises correction_ledger_projection_mismatch and never rewrites history. Fixture source adds first-insert status transformation plus retained status/description divergence on replay; each requires the precise error, no additional whole-book change, and rollback of fixture injection. Actual trigger permission to inject divergence must be demonstrated; earlier refusal does not qualify the replay check. Read checks are immediate statement snapshots, not commit-stable exclusion of concurrent/deferred mutation. Those qualification boundaries remain open. Prior journal-revision bytes are preserved under history-journal-revision/.

## Metadata origin fixture correction

The object-metadata positive case explicitly sets metadata_sql_null=false regardless of supplied input. A separate fresh SQL-NULL-origin case runs after rollback of the object case, asserts identical replay and conflicts against JSON null/empty object, and verifies complete row rollback. Both origins are executable source cases, unrun. Writer and private-intent bytes are unchanged. Prior fixture is preserved under history-posted-replay-revision/. Source admission, push and publication remain held; no readiness polling is authorized by this package.
