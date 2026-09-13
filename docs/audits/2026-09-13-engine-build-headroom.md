# Engine build headroom

Normal releases 34771120941 and 34771886078 refused to start their bounded
builds because the production host had less than 1,310,720 KiB available.
The last measured availability was 1,285,000 KiB. The currently sealed engine
remained healthy at de406ca925f0b83c02a6c46c4dedc61b1010dd27; no cutover occurred.
The engine journal and HorseFleet finalizer fixes therefore remained pending.

This forward change uses an 896 MiB dedicated builder with the existing 768 MiB
compiler heap, 256 MiB host reserve, zero swap and one CPU. It requires
1,179,648 KiB available and reports both measured and required memory on refusal.
The new builder identity prevents reuse of the previous resource configuration.
Exact cgroup readback, immutable source extraction, image provenance, bounded
cancellation and cleanup remain enforced. There is no low-memory fallback.

The resource sizing was recovered from draft PR4460, whose isolated native run
34697728350 succeeded against its then-current source. That earlier evidence is
research, not proof for this release. PR4460's experimental compiler changes
and their subsequent restoration are not part of this forward change: the
current protected-main Dockerfile and compiler settings remain byte-identical.
That draft and its failed Silent Revert Guard remain untouched. No approval
label, guard exception, history rewrite or production restart is used here.

The same native resource workflow must test this exact current source: complete
runtime comparison, real cgroup OOM containment, a surviving neighbor, process
group and parent-only cancellation, and cleanup. The local release-law suite
also tests the exact free-memory boundary: acceptance at 1,179,648 KiB and
refusal one KiB below it. A successful resource test is not production proof;
the normal engine release still must produce its sealed live receipt.

Local validation: all 56 release-law checks passed, including native execution
of the production build wrapper at the exact memory boundary. The focused
Node test configuration was used because this Mac lacks the unrelated React
Vite plugin; required CI still runs the repository configuration. `git diff`
confirmed no Dockerfile or compiler change. Native Linux proof is pending.
