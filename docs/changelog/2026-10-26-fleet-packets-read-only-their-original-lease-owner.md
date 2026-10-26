# Fleet packets read only their original lease owner

The bounded canonical fleet query now probes the classic submission archive only for classic hands. Lightning hands retain their original private committed lease and skip the unrelated classic lookup. The 1,500 ms statement timeout, 250 ms lock timeout, hand limit and private-output rules are unchanged.

The packet command classifies verbose PostgreSQL SQLSTATEs into closed cancellation, lock, permission, schema, authentication and connection categories. It never prints stderr, connection details or query payloads. Oversized replies are reported separately; unknown failures remain unknown.

Isolated PostgreSQL tests execute the prior and corrected query: the Lightning-only fixture probes the classic archive before and performs zero archive scan loops afterward. Mixed classic/Lightning original leases, pending acceptance, actual statement cancellation, schema refusal and redaction remain covered. This is not a claim that a production window completes within its deadline; the next original qualified observer supplies that evidence.

The canonical summary also retains bounded capture diagnostics before private cleanup: attested selected/source-owner counts, inspected/remaining counts, charged bytes, accepted decisions, stop flags and sanitized retained-gap counts. Missing older fields remain unknown. Inspected hands are explicitly not a continuation cursor and may include incomplete hands. These diagnostics explain a partial observation without claiming complete capture or full-fleet use.
