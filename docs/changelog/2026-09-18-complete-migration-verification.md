# Complete migration data reaches the trusted verifier

The trusted PR verifier refused a valid 1,000,956-byte recorded migration because its inline reader capped every file at 1,000,000 bytes. The reader now accepts complete migration data up to 5 MB. It retrieves omitted Contents payloads by the blob hash returned for the captured PR head, and verifies the byte count, Git blob hash, canonical base64 and UTF-8 before handing SQL to the existing declaration verifier. It never follows a download URL or executes candidate SQL.

The same reader serves changed migrations and policy declaration records. Existing dispatch bundle bounds, live catalog checks, reporter identity, protection checks and final PR-head verification remain intact. The actual producer is exercised through a closed transport in the existing required CI caller suite, including both large-file representations and refusal of truncated, altered, oversized and stale-head input.

Validation: both large-file regressions fail on the predecessor and pass after the repair; all 13 producer boundary cases pass. A read-only fetch of the failing PR file returned all 1,000,956 bytes and SHA-256 `9f6e0b02abea54394d317c6d20f8e47ae10edefc9ba6c12f6542c23daf4540c4`. No migration was installed or executed by this change.
