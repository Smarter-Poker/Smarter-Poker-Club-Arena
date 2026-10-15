# The Horse Journal Disk Walk Survives A Retired Segment

**Date:** 2026-10-15
**Area:** Horse Brain, decision lane (`server/src/services/horseDecisionJournal/config.ts`)

## What Was Wrong

`/health.liveHorseDecision.workerCount` read 3 on release 38e91da and 2 on releases e848247e and 3002fe25,
with no change to the host or the worker rule. The engine log on 3002fe25 said why:

    [HorseDecisionLane] journal disk capacity unreadable; retaining legacy two-worker ceiling

`horseJournalShardCapacity` measures the existing archives with `du -sk`. The archives are at their byte caps,
so retention retires segments continuously, and `du` met segments that were unlinked between the directory listing
and the stat. A read-only rerun on the host printed eleven `cannot access ...: No such file or directory` lines in a
3.9 second walk and exited 1. That exit was treated like any unreadable reading, so the lane fell back to two
workers on a host whose budget admits three (17,295,921,152 bytes free; archives 14.3, 14.0 and 5.8 GB).

## The Fix

Exit 1 is accepted only when every stderr line is a vanished path inside the scanned archives and the totals are
complete. That reading is exact for the budget: an unlinked segment is counted as free by the later `statfs`, and its
absence from the allocation is charged again as remaining growth, so allocated plus free is unchanged and no worker
is admitted that the disk cannot hold. Any other error, a timeout, a signal, another exit code or a path outside the
archives is still refused and still retains the two-worker ceiling.

## Pinned By

`config.test.ts`: the retired-segment reading is accepted, and four other failures are still refused.
