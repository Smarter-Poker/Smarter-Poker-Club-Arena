# Independent Horse reads and qualification coverage

## Change 1: complete retained-hand reads

Before: `server/src/services/horseDecisionJournal/review.ts:755` returned the
first archive containing any records for a hand, ignoring other fragments,
conflicting copies and unreadable later archives. Three regression fixtures
fail against this implementation; identical-event deduplication already passes
because the reader never reaches the second archive.

Change: collect validated records from every listed archive, deduplicate identical
event identities, refuse conflicting bytes or any unreadable archive, and order
by producer and sequence. Single-archive ordering must remain unchanged. This
repairs an evidence reader, not a claim that every live hand is captured or that
any strategy is qualified. The earlier audit's unmatched hand remains unexplained.

Verified: reread repaired source. Three original regressions failed before the repair;
250 focused review/config/review-tool tests pass, including aggregate record limits.
Server and client TypeScript checks pass. Hosted/protected/live evidence pending.

## Change 2: discover retained shards after a numeric gap

Before: `config.ts:192` stopped at the first absent numeric shard. Its old
test pinned that behavior even though the function promises every retained
archive. Change the directory inventory to canonical names sorted numerically,
including later retained shards. Ignore noncanonical lookalikes. This also
keeps disk allocation accounting from ignoring those same retained archives.
Missing storage still refuses through the original reader; no directory is
created. Both changed discovery fixtures failed before the repair and pass afterward.
All 42 config tests pass, including disk allocation/refusal cases.

Scope: preserve all 62 retired horses and all qualification gates. Independent
public-history reads and activation remain separate acceptance items; no shared
private cards or live team feeds, no unqualified activation.

## Change 3: connect batch qualification consumers

The Phase 6D population and chain-export tools each bypassed the canonical
reader with `journal.readHand` on their current shard. Two wiring regressions
fail on those paths. Route their hand reads through the complete canonical
reader and require its version-2 contract before collecting qualification
evidence. Older images must report unavailable, never silently use the old
first-fragment reader. Preserve existing scan/deadline/custody bounds. Inspection
also found that population admission counted repeated copies of one decision:
require retained event identities/digests, count identical copies once and refuse
conflicting copies. Two admission regressions fail before this correction.
Keep the current catalog's decision selection and capture-continuity attribution;
other archives supply hand context, not a false local continuity claim. Native
SQLite fixtures exercise that boundary. Export binds each record's validated
digest to the population before writing output. Older population artifacts
without decision digests are explicitly unbound; collect new evidence instead
of synthesizing those fields. This does not certify an entire retained
window. Verified: source reread, 271 focused/native tests and 1,132 root law/source-window
checks pass; server TypeScript and both script syntax checks pass. Protected
checks, installation and actual live proof remain pending.
