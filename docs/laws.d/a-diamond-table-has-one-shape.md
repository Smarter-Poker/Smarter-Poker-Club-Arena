# tests/a-diamond-table-has-one-shape.law.test.ts

"Is this a plain Diamond cash table" was answered in six places, and on the morning of 2026-09-12 the five SQL copies had six different md5s and three different answers.

The SQL half is one function now, `fn_poker_diamond_plain_cash_table`, and every Diamond money door and staff door reads it. The sixth copy is the engine's TypeScript boundary, which runs in another language in another process and cannot share the function. This law is the only thing that notices when one of the two learns about a column and the other does not.

It compares the SET OF COLUMNS each side decides with, not the phrasing. SQL says `IS DISTINCT FROM 0` where TypeScript says `typeof !== 'number' || !== 0`, because a NULL and an absent key are the same fact in two type systems. The phrasing is allowed to differ; the columns are not.

The per-hand checks are outside the comparison on purpose. Whole blinds, a whole ante and the bomb-pot ante are arithmetic about a hand rather than the shape of a row, and the SQL doors carry their own whole-amount check.
