# Engine Replacement Uses Its Owner's Proof Deadline

The owner-ordered Lightning reset (release run 40220380663) built and qualified its image, announced the last hand and installed the entry-blind role constraint in the certified freeze. Candidate replacement then failed its nested 75-second launcher cap. The outgoing stop alone consumed 63 seconds. The release recovered the exact sealed previous engine; all 495 tables resumed after thaw. The candidate did not seal.

The launcher now requests the existing candidate-proof budget from `bounded_break_command`. That helper still clamps every command to the actual absolute proof time remaining, the overall operation deadline and its two-second TERM/KILL margin. All subsequent local/public/database identity proof consumes that same deadline. The five-minute break, 150-second candidate budget, 135-second rollback reserve, immutable image, drain and seal checks are unchanged. No retry loop, new window or second publisher is added.

A regression executes the actual candidate dispatch and bounded shell helper with an independently modelled 80-second replacement. Before the fix it is refused despite 100 seconds of proof time remaining. Afterward it launches with a 98-second bound, while either a 70-second proof or overall deadline still refuses it. Existing image-prewarm ordering and release/recovery tests remain enforced.

A corrected protected release and live sealed identity are still required. The installed migrations must never replay. The existing owner window and rolling-hour admission retain authority over any further cutover.
