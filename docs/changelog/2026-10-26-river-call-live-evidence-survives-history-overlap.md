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
the existing completion deduplication remain in force. No migration or retry
path is added.

The regression fails before the change for missing and empty history
categories. All three cases (missing, empty and populated categories) pass
afterward, retaining one hand and one river-call observation across repeated
history and completion delivery. The focused history adapter, observer and
history packet suites pass 70 tests. Live installation is a separate release
gate; this source/test evidence does not certify production activation or
all-1,000-horse persistence.
