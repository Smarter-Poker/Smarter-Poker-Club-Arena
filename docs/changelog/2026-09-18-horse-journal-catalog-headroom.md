# Horse journal catalog capacity preserves new decision evidence

Phase 6A reached production in the containing engine release `8825af51817f379c4261658ca29ecc9d8d81932d`, but its natural accepted-action verification found an exhausted journal catalog. The catalog occupied all 524288 allocated pages with no free pages, while compressed records used 4.99 GB of the existing 8 GiB allocation and 262387 of 500000 segments. Sixteen reserved records remained pending. The fixed natural sample could not qualify current-release hands; that incomplete observation remains evidence and is not replaced by a success claim.

The normal journal writer now applies a shared, finite 4 GiB catalog ceiling before completing pending custody. At the observed index density, the existing 500000-segment allocation needs approximately 4.09 GB. This is workload-based sizing, not a guarantee every possible record mix fits. SQLite grows the catalog on demand. The 8 GiB compressed-data limit, segment count, private paths, schema version, durability, immutable files, read bounds and capacity refusal remain unchanged. No records are deleted and no release or repair loop is added.

Regression checks inspect the actual writer page limit and reproduce real SQLite FULL during index publication with a small test-only allocation. They retain the pending batch and exact segment bytes, reopen through the normal constructor, verify replay without duplication and accept a new append. Existing archive custody tests remain required.

Decisions absent during terminal journal unavailability cannot be reconstructed. Live qualification must report that gap and inspect a finite natural cohort after recovery. Once a catalog grows beyond 2 GiB, an older engine with the former limit cannot reopen its writer; rollback must preserve the larger catalog allocation or explicitly report unavailable journaling. A read-only observer's reported ceiling describes its release's source policy, not proof that another writer applied it.

Publication and post-recovery live verification are recorded separately in the owning Horse delivery checkpoint.
