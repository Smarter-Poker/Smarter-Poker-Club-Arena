# tests/no-chip-reader-sums-a-diamond.law.test.ts

Ruling 16 says the Diamond Arena has no chip wallets and no chip ledgers. The
quiet way to break it is not to write a chip row for a Diamond, it is to ADD a
Diamond to a chip total in a reader: no row is written, nothing refuses, and the
number that comes out is of nothing at all. Step 0 of the destinations design
fixed the hourly chip supply meter for that reason and left three readers of the
same two pools alone. One of them is the hourly freeze circulation mark, which
the break scorecard subtracts pre from post to decide whether chips conserved,
so a Diamond player standing up between :55 and :00 would have made the break
report a chip failure with no chip having moved. All three now exclude a pool
that is KNOWN to be Diamond, and only a known one, so an orphan seat or
membership is still counted as it is today. The Diamond is not lost by leaving
the chip books: its custody row is inside fn_ca_arena_diamonds(), which the
Diamond identity closes on.

AND THE PROOF READS ONE SNAPSHOT (2026-10-04). The first migration to carry
this change, 20261004124546, was correct in substance and could not apply. Its
section 0 captured the unfiltered figures and its section 4 read the filtered
figures afterwards and required equality, so it asserted both "the Diamond
exclusion changes no chip figure" and "no unrelated player did anything while I
was open". Two statements are two snapshots at READ COMMITTED, and the second
claim can essentially never hold on a live floor: it refused itself twice, the
second time with every money figure identical to the cent and seats 1632 ->
1631, one player standing up inside 334 ms. 20261004194622 supersedes it and
reads the filtered and the unfiltered figure in a SINGLE statement, which is
one snapshot, so the equality it requires is about the Diamond filter and
nothing else. No money comparison is loosened and none has a tolerance; the
chip circulation report is now compared figure by figure instead of only by row
count, and the migration refuses if a reader it calls inside a comparing
statement is no longer STABLE, or if any figure reads NULL.
