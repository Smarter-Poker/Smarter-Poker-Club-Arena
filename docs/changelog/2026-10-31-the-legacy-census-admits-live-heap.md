# 2026-10-31: the legacy census admits live heap against its real worst case

## What stopped the release

The 13:55Z owner-window cutover (run 41207992369) reached its break with a
certified freeze and was refused by the predecessor's own one-shot
checkpoint, before any census or guard ran:

    native census memory headroom refused
    usedHeapBytes 3,913,011,648  availableHeapBytes 322,107,592
    requiredHeapBytes 3,946,566,080

The admission rule demanded a second full heap of free space (used + 32 MiB).
eed06fe5 has a ~2 GB live working set on a ~4.2 GB limit: a freshly restarted
instance read 1.97-2.30 GB used about 40 minutes after start (2026-10-31
17:10Z samples), so the rule could only ever pass in the first minutes after a
restart. Every :55 and 04:00 attempt that needed the census was refused.

## The two changes

1. `censusGarbageCollection`: one `HeapProfiler.collectGarbage` is requested
   before the memory reading. `used_heap_size` counts dead objects until the
   next major collection, and `Runtime.queryObjects` begins with exactly that
   collection anyway, so the reading is now live heap. A lost answer is an
   unknown outcome and refuses like every other inspector operation.
2. `requiredHeapBytes = ceil(usedHeap / 3) + 32 MiB` (was `usedHeap + 32 MiB`).
   The broad census queries `Object.prototype`, so its JS-heap cost is one
   array of 8-byte pointers, one per matching object, and every matching
   JSObject is at least three words (24 bytes) already counted in used heap:
   the array is strictly at most `usedHeap / 3` (the same ratio with pointer
   compression: 4-byte pointers, 12-byte objects). The census measured in
   production for #8908 costs about 280 MB at 35M objects and 3.9 GB used, a
   fifth of the bound. The off-heap handles and
   result vector are unchanged under `requiredProcessBytes = 8 x usedHeap +
   32 MiB`.

The 13:55Z reading is still refused under the new rule (pinned); a fresh
predecessor at 2.7 GB live is admitted (pinned); the rule never admits less
than `usedHeap / 3 + 32 MiB` (pinned). The rule passes while live heap is
under about 3.15 GB of the ~4.2 GB limit.

#8908 (bounded native census through a pinned V8 addon) is the complete
answer for a long-running predecessor at 3.9 GB; this change is the minimal
Inspector-path correction and does not conflict with it. The transport harness asserts the
collection precedes the admission on both the success and refusal paths.

## Not changed

`scripts/ci/read-scoped-release-recovery.py` (production-integrity-audit,
read-only) still reports the old predicate under its own label
`4fef_32MiB_8x`; it gates nothing.
