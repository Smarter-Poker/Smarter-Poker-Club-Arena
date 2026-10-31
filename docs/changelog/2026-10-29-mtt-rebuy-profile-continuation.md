# Preserve unanswered rebuy input when player identification is unavailable

The horse rebuy input device treated an error, null response, or thrown transport failure while reading profiles as an empty human-only batch. It returned no pending work, so its existing bounded continuation stopped even when an open offer still needed an answer.

The owning read now distinguishes unknown identification from a successful empty result. Unknown identification retains the existing two-second, maximum sixteen-pass input continuation; it never infers an identity, choice, purchase, or decline. A successful human-only result still stops. The database owns offer expiry and every financial operation.

Regression tests reproduce all three failures before the fix, prove a recovered read submits the original response, and bound persistent failures without money calls. This source defect is not yet linked to a specific production stall. Publication and live recovery evidence are tracked separately.
