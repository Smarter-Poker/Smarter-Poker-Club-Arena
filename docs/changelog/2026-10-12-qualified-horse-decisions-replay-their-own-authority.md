# Qualified Horse Decisions Replay Their Own Authority

A current-release natural replay of 200 decisions reached 125 exact results,
70 named Phase 10 admission refusals, and five retained FAST-view second
looks. The replay injected an incomplete worker dependency set: unlike the
live worker, it never invoked the protected release authority verifiers.
Missing callbacks correctly kept its fresh holders unselected, so qualified
cash decisions could not reproduce their original candidate admission.

The offline replay now invokes the same release verifiers, qualification
hashes, policy digests, domains and withdrawal checks as the live worker.
An applied owner's existing journaled receipt supplies its original epoch
and local generation only after its complete qualified identity agrees with
the verifier. A missing, mismatched, withdrawn or unavailable input remains
a named refusal. Fresh production holders, ordinary admission and generation
guards, the wire protocol, strategy files and replay-state schema remain as
before. The constructor seam is trusted in-process construction only; no
live request can provide an authority holder.

Regression evidence uses the real worker and actual committed qualification
bytes. The qualified-candidate test fails with the original replay wiring
and passes with this correction. A fresh-process applied PLO4 decision
reproduces its original authority epoch; focused cases preserve stale
generation/epoch, duplicate admission, withdrawal, missing/corrupt evidence
and full qualified-identity refusal. The replay still has no network,
database writes or plan application. Policy digests are checked against the
base source, without changing their file lists.

The original 70 refusals stay unverified historical evidence. A modified
verification path is not the original complete release SHA; fresh declared
production evidence on the containing release is still required. No live
plan effect receipt is backfilled or edited by replay. In the current sample,
candidate changes retired reference plan effects rather than issuing them;
empty candidate lists on retained reference receipts do not prove candidate
withdrawal recovery was exercised.
