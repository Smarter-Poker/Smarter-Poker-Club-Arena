# Horse public-history reads use an exact-context covering index

The original-participation v2 reader filters observer, game variant and dealt count before choosing its 512 candidate hands. Production only had an observer/time index, forcing heap reads of other contexts. On October 27 at 10:03 Central, 26 concurrent v2 requests were waiting on DataFileRead, with requests approaching the database's 8-second deadline. PostgreSQL logged 3,070 statement timeouts during 14:45–15:04 UTC; this count covers all workloads, not only the reader.

The new concurrent index keys observer, variant, dealt count and newest-hand ordering, with candidate metadata covered and the reader's exact original-participation predicate. The reader definition, pinned checksum, eight-day retention, independent observer context, original seat/position proof, public-only projection, permissions and retired identity refusal remain unchanged. No engine replacement or client build is required for this database access-path repair.

The existing directly triggered PostgreSQL qualification now reproduces sparse-context heap filtering across 100,000 unrelated-context rows, verifies an index-only range with the new cover in both custom and generic plans, checks byte-identical sparse and empty responses, and refuses a wrongly shaped existing index. Its existing privacy, context starvation, format, cutoff, payload-bound and 62 retired-identity checks remain active.

Production installation must use the merged migration's existing concurrent preamble and recorded transaction through Apply Merged Migration. Source and native proof alone do not establish live recovery; retain installation and authenticated page evidence in the task checkpoint.
