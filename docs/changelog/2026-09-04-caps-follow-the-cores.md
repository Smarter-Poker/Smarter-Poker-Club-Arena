# The concurrency caps were sized for hardware we no longer run

Two caps were added earlier today to stop CI thrashing:

- `vitest.config.ts` pinned `maxThreads` to **2**
- `vite.config.ts` pinned rollup's `maxParallelFileOps` to **4**

Both were correct. The CI boxes were 8-core, several jobs shared each box, and
uncapped vitest opened a thread per core per job - 37 node processes on 8 cores,
load 40, nothing idle. Capping cost about four seconds per job and gave back far
more than that in contention.

Then the boxes were rescaled to **16 cores** (cpx42 -> cpx62) a few hours later,
and the same two constants became the bottleneck they were introduced to
remove: half the machine sat idle while a hard-coded 2 throttled the suite.

That is the failure mode worth naming - **a number tuned to hardware, written
down as a constant, and outliving the hardware.** It would have gone stale again
on the next resize, silently, with nothing to point at.

So both caps now derive from the box:

    vitest  maxThreads        = max(2, cores / 4)
    rollup  maxParallelFileOps = max(4, cores / 2)

The divisors assume roughly four heavy jobs sharing a box, which is what one
pull request actually places there. On the 8-core boxes this yields exactly the
values it replaces - 2 and 4 - so the change is a no-op on the old hardware and
a speed-up on the new, and it cannot go stale on the next resize.

`VITEST_MAX_THREADS` and `ROLLUP_MAX_FILE_OPS` still override, for pinning a
specific number when measuring.
