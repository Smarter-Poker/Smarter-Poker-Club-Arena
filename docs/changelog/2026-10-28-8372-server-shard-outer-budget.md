# Let the server shard honor its existing test deadline

PR #8372 job 122518658540 was cancelled at the 15-minute job ceiling. Its full server suite received only 14 minutes after checkout, compilation and the named regression step. Reconstructing Vitest's SHA1 shard allocation identifies HorseV54RiverBluff.test.ts as the only unfinished file: all other 402 assigned files completed. That file already permits a 900,000 ms individual test, including its fixed 6,000-pair PLO6 case at seed 4242.

The server shard job now has a bounded 25-minute ceiling: the observed 7m25s through the last completed file plus the existing 15-minute test allowance leaves 2m35s for cleanup and scheduling. The prior successful comparable shard completed in 6m45s (job 122473453067); this is a deadline-envelope correction, not evidence that this cancelled run passed or that more time guarantees success.

All seven V54 cases, pairs, seeds, assertions, individual timeouts, four shards and required accounting/server joins remain unchanged. Only the six active CI input pins are refreshed, with their previous identities retained; historical receipts and qualification state are untouched. Hosted completion is still required.
