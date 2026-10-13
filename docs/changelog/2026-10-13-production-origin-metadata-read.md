# Read Complete Publisher Metadata Within The Existing Admission Budget

Post-deploy runs 38466068832 and 38467244117 failed before browser setup when the GitHub jobs request with per_page=100 returned HTTP502. A bounded read of the same source run with the documented default page size30 returned all nine jobs and total_count9. This is a measured request-shape failure, not a claim that every100-job request fails.

The original origin gate now obtains complete latest-job metadata with30-job pages and bounded GET-only retries for explicit HTTP5xx responses, within its original30-second outer budget. Counts, page sizes, duplicate identities and changing totals refuse incomplete metadata; neither errors nor unknown responses become an empty successful publisher. All existing origin transaction, retention, proof-step and downstream certification assertions remain unchanged. No publication, fixture or other mutation is retried.
