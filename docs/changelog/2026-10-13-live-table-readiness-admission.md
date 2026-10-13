# Live-Table Readiness Read Admission

Production run 38448498735's SNG case failed during baseline readiness, before navigation or reconnect. Its final health request was allocated only 52ms. The endpoint returned HTTP 200 headers, but the request body could not finish before that artificial transport deadline. The readiness poll ran 90 seconds while its read deadline ended one second earlier, allowing a final poll callback to launch a request with virtually no time remaining.

Repair the original readiness admission: start another health-read attempt only when the existing 15-second health request budget fits inside the unchanged readiness deadline. Late callbacks retain the last complete read and cannot clear an earlier genuine operational failure. This does not extend the 90-second observation budget, relax engine health/board eligibility, turn absent subjects into passes, or satisfy missing SPIN/SNG coverage. Existing required coverage continues to refuse incomplete cases. No production state or game actions are changed.

Focused regression reproduces the 52ms admission arithmetic, refuses late/invalid admission and pins the existing readiness callback to the maintained helper before its operational-failure wrapper. Full production acceptance remains the owning task's responsibility.
