# tests/a-diamond-hand-keeps-its-own-statistics.law.test.ts

A player's statistics are figures in one asset. The per-hand stat table and
the player-to-hand index had no asset column and every stats reader took only
the player, so the first Diamond hand ever dealt would have added its profit,
winnings and rake to that player's chip figures, with nothing able to take
them apart again. Both tables now carry `asset`, set from the hand the row
describes (its table's club, else its tournament's club) by one BEFORE INSERT
OR UPDATE trigger, so every writer - the post-commit projection, the
hand_history trigger, the forward roll, the index refresh, the seat backfill -
labels a Diamond hand as Diamond, and a writer that names the wrong asset is
overruled by the hand. The eight readers behind the stats page, pulse, EV
curve, hand grid, grid cell, rake and nemesis take `p_asset` (default chips, so
an existing caller keeps its answer) and read that asset only; the old
signatures are dropped first, because an extra defaulted parameter would add
an overload and make every existing call ambiguous. Retention keeps each asset
its own window. The law pins the preflight that no Diamond hand existed before
the default labelled history chips, the trigger on both tables, the column
added without an index build or a validated check under the lock every hand's
projection waits on, all eight reader edits pinned and reversible, and the
grants each reader had. The rehearsal dealt one Diamond hand through the real
projection: its 8 index and 8 stat rows were all Diamond, the player's chip
page, pulse, EV curve, grid, cell hands, rake and nemesis were unchanged, and
the Diamond reads returned that one hand.
