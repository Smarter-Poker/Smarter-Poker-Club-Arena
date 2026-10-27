# Recover individual public history after a failed read

A horse's first individual-history request previously settled permanently as unavailable after a transient error. The worker also refused a later packet once its initial pending state had ended. Raising the transport deadline did not repair either permanent state.

A later actual decision now admits one coalesced read after a sixty-second failure cooldown. There is no timer, watcher or background repair. Turns do not wait on database I/O. Successful windows keep their existing acknowledgement and cutoff contract.

The observer can install a recovered window after initial unavailability. It reconstructs public observations chronologically with its retained live completions, deduplicates committed hand IDs, and preserves plan maps held by issued decisions. Its live tail remains bounded to sixty-four hands and 256 KiB; a truncated tail is explicitly capped. Observers, variants, formats and original dealt counts remain isolated. No shared opponent profile or private cards enter a read.

Three new regression cases fail against the original source and pass with recovery. Real HorseLogic tests cover both overlapping and non-overlapping historical/live hands. A dispatch-only pinned-SSH inspection reads up to sixteen explicitly selected journal hands and emits selected opponent counters, independent-history receipts, execution status and phase authority summaries. It exports no private cards or full read frames and cannot publish or activate anything.

Incident context: the October 26 WooWoo investigation found 330 individual-history error fires since 01:15 UTC October 27. This is aggregate evidence, not attribution of all failures to WooWoo's opponents. A fresh installed reader returned a valid WesJr PLO5 six-player window with 64 hands, 39 involving WooWoo. The old aggregate horse_mind_stats timestamps do not establish freshness of independent observer views. Protected integration, serving-image identity and per-horse accepted-decision inspection remain separate delivery evidence.
