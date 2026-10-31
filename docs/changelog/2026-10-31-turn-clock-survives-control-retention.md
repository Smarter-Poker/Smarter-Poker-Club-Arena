# Keep the current decision clock through control retention

A control-only continuation checkpoint can temporarily withhold the action context during TURN_CHANGE's animation settle beat without changing the poker decision. Comparing that withheld token to the original token skipped the only turn-clock handler. Retention later restored the input token but did not restore the skipped timer.

Compare the controller's decision identity across the asynchronous beat instead. Keep running/current-engine/lifecycle and changed-decision guards, and continue publishing only the durability-gated action context. The actual continuation queue regression reproduced the missing timer, then verifies one real timer, a withheld discrete event token, a successful HTTP action after retention, and no stale timer for changed or stopped decisions. This is isolated behavioral proof, not attribution or live verification of a particular player's report.
