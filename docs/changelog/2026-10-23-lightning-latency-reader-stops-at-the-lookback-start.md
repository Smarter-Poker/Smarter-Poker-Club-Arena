# Lightning Latency Reader Stops At The Lookback Start

The R19 qualifier pages back through public.fn_lightning_operator_cluster 60 windows at a time. When a full page's oldest window began at or before the lookback start, the reader asked for one more page whose start was after its end, the database refused it (INVALID_WINDOW), and both pilots read UNKNOWN (runs 39965786415 and 39966029770, 240 minute lookback, exactly 4 full pages). The reader now stops once a page reaches the lookback start. The test reader refuses an inverted window the way the database does, and a new test reproduces the production case.

Tooling only.
