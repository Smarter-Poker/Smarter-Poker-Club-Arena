# server/src/maintenance/theClockIsTheLastWitness.law.test.ts

A break with no row is still a break: an engine that boots inside the :53 ->
:00 window and finds no adoptable row (absent, unreadable, stale or expired)
holds the fleet to the hour from the UTC schedule alone instead of dealing
(2026-09-08: two mid-window cutovers dealt 945 and 641 hands under a countdown
every screen was showing); it never holds anything outside [:53, :00); a row
that can be adopted still wins; and a `counting_down` break that expired while
no engine was alive to end it is thawed before its row is cleared, so the
frozen minutes are handed back instead of burning every in-flight deadline.
