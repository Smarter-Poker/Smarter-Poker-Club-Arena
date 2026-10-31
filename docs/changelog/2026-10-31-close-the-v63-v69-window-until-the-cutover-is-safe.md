# 2026-10-31: close the Horse V63-V69 :55 window until the cutover is safe

The owner-ordered window `2026-10-31-horse-v63-v69-next-55` (open until
23:15Z) took the 19:55Z break. The live native census exceeded its 30 s
request allowance (checkpoint never invoked, no hand touched), the release
stood down and eed06fe5 was recovered, but the platform stayed frozen
19:54:37Z -> 20:20:26Z: the predecessor waited in its Deployment Recovery
release boundary for a v3 transaction that had already retired, and only an
engine restart let it adopt the break and thaw (1,512 s credited).

The stage re-offers an owed engine every 3,000 s, so the next push after
about 20:53Z would offer main again and take the 21:55Z break with both
defects unfixed. This change selects the previous floor witness again (the
noon window `2026-10-31-mtt-manual-noon-safe-drain-continuation`, byte-for-byte
its recorded witness a223b2ae..., expired 15:20Z), so no off-cycle activation
is admitted. Every historical window entry is unchanged; nothing is retried,
withdrawn or dispatched by this change.

A new owner window for the next :55 is selected once both fixes are on main:
the census fits its allowance, and a pre-invocation refusal completes the
thaw inside the break.
