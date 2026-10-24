# Lightning Pool Badge Retired With The Entry Card

PR #7890 replaced the Lightning entry page with the approved cash-game card and removed the pool badge from that page. The badge had no other caller, so `tests/every-file-under-src-is-reachable.law.test.ts` failed in `publish-club-arena.yml` (run 40072415219, shard 4) and stopped the client publish for main.

The orphaned `src/components/lightning/LightningPoolBadge.tsx` is deleted. No behavior changes: nothing rendered it after #7890.
