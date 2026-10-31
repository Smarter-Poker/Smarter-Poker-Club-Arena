# A tournament countdown requires its durable deadline

A returned database error previously left `beginBreakCountdown` marked started and broadcast a deadline that had not been saved. A replacement could then reconstruct a different end time.

The original break operation now keeps its first deadline, coalesces concurrent callers, and binds the write to the exact start proposed by its original pause request and verified in persistence with a previously empty end. It verifies the returned row or reads back an ambiguous acknowledgment once. Unproved results throw without announcing success; a caller retry keeps the same proposal. A matching durable deadline can be adopted without rewriting it, including equivalent timestamp offsets. No timer, sweep or new retry loop was added.

Regression coverage includes returned failure, lost acknowledgment, duplicate callers, replacement adoption, different-break/deadline refusal and existing lifecycle, add-on and restart acceptance. This is a source correction; publication and production behavior require separate verification.
