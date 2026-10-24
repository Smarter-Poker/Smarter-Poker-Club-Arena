# MTT continuity failure evidence

An MTT certificate observed a 51-second gap between a paid hand and the next deal. Its failure classification read the board repeatedly before retaining engine state, and the incident's host logs were no longer retained when the scoped log reader ran.

The MTT failure path now retains one scoped engine-health response before those board reads. It preserves the selected table's loop phase, hand number, progress age and pause state, including an unhealthy HTTP 503 response. The read has a three-second deadline, retains only diagnostic fields, and reports unavailable evidence without replacing the original failure. The gameplay silence limit remains 45 seconds.

This change improves the evidence needed to identify the blocked operation. It does not claim to repair the original gameplay delay. The root cause and fresh MTT, SPIN, SNG and cash/reconnect certification remain open until the required database index is installed and the live checks execute.

Validation includes unhealthy, missing-table, rejected, malformed, oversized and transport-failure responses, plus a source contract requiring capture before delayed board classification. The source contract fails before integration and passes afterward.
