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
