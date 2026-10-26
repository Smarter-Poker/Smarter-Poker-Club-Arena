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
