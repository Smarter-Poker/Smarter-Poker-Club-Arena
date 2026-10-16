# Lightning Pilot Report Records Actual Replays

The pilot handoff still requires an authenticated replay witness, but the read-only qualification report only counted hands with history links. Its existing manually invoked workflow now calls `fn_lightning_operator_hand_replay` for the first and last three recorded settled hands per verified private target, deduplicating overlaps. No new workflow, timer, session, account, financial fixture or control write is introduced.

The collector validates Cluster, hand, history, settlement and nested replay identities, preserves defect codes, and refuses errors or mismatched results as UNKNOWN. Arbitrary payload, cards and credentials are never copied into the report. A real replay defect adds a failure blocker; no samples remain missing evidence. The output explicitly says sample_only and does not certify all hands or the retained launch workload.

Twenty-seven report/collector checks passed, including bounded selection, duplicates, empty results, mismatched identity, unavailable reads, real defect codes and output filtering. The existing workflow runs these tests before collection. Actual authenticated production execution remains pending protected integration and a fresh explicit report dispatch.
