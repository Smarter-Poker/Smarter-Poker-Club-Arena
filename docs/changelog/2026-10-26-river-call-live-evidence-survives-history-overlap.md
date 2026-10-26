# Live river-call evidence survives partial history overlap

An observer can finish a hand while its initial public-history request is
pending. If that same hand appears in the history response, hydration used
to learn the history version first and discard the queued live completion
as a duplicate. A failed or incomplete optional category read therefore lost
public river-call evidence that the live completion already supplied.

Hydration now uses the already admitted live completion when its committed
hand ID and exact table/hand coordinate match the historical hand. It learns
that completion once at the historical hand's original chronological position.
Original-participant binding, private observer isolation, history cutoffs and
the existing completion deduplication remain in force. No new migration or retry
path is added.

The regression fails before the change for missing and empty history
categories. All three cases (missing, empty and populated categories) pass
afterward, retaining one hand and one river-call observation across repeated
history and completion delivery. The focused history adapter, observer and
history packet suites pass 70 tests. Live installation is a separate release
gate; this source/test evidence does not certify production activation or
all-1,000-horse persistence.

The exact unchanged river-call persistence migration also lacked native
qualification: older green evidence exercised the observation-window migration.
The new isolated PostgreSQL 17 harness reproduces both installed RPC preimages
and checks the actual migration, older-engine compatibility, GREATEST merges,
source-window coverage, permissions and transaction rollback. It runs in the
existing required accounting shard. No production database is used by this test.

Dan later directed all authorized upgrades to release when ready on October 26
only, rather than wait for 04:00. The expiring named owner window carries only
this river-call delivery and its unchanged migration through the existing
certified freeze and installer. It retains the transaction, lock, proof,
rollback and thaw safeguards; no general maintenance schedule changes.

The stronger retained-history proof exposed an insertion-order bug in packet
digests: journal serialization sorts object keys, so a valid history packet
could fail validation after storage. History digests now canonicalize object
keys while preserving array order. The actual journal round-trip regression
fails before the fix and passes afterward; content changes still fail.

The existing bounded, read-only fleet reader now reports qualified river-read
and retained-history evidence separately for each selected horse. It validates
the original accepted execution, exact release, independent observer receipt,
read frame, current scope and matching retained history packet. It emits counts
and explicit unknowns rather than cards or opponent identities, and preserves
all read limits. These observations do not establish every context, lifetime
memory or strategy quality.

The older #8214 release also found one PLO6 invalid receipt in its activation
law. The original test retained no rejected input. The law now keeps bounded
synthetic rejection details and initializes each filtered variant's existing
gate fixture independently. A single diagnostic 100-hand cohort found no
invalid receipt; this is not a runtime root-cause fix or a passing replacement
for the failed release. Existing phase and zero-refusal assertions remain.
