# Post-deploy verification recognizes the protected client publication caller

The publisher now reports its origin and retained-runtime jobs inside `client-publication / production / ...`. The post-deploy reader accepted only the earlier bare and `production / ...` names, so a successful web publication was refused before automated browser verification began.

The reader now recognizes the exact new caller names for those two jobs. It retains complete job metadata, unique logical origin, successful publication/proof steps, failed-retention refusal, foreign-prefix refusal and all existing publication safeguards. Gateway job admission and the production verification suites are unchanged.

Focused regression cases reproduce the rejected successful publication and retention and the previously overlooked ambiguous logical origin. They verify the fixed reader admits the valid nested proof and still refuses failed proofs, foreign names and duplicate logical origins. Delivery requires protected merge and a new automated post-deploy run executing the corrected reader, with actual browser results read separately from engine verification.
