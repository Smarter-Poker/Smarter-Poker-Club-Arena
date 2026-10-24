# Preserve the opponent memory read budget

A required Linux qualification read of ten players with 1,024 actual observations each timed out at the unchanged 1,500 ms PostgreSQL budget. The earlier comparable passing read took 1,480.6 ms.

Historical initialization now consumes an internal integer-counter parser with the same action loop, avoiding construction and parsing of a 27-field JSON object for each actor and historical hand. It computes the same two decay weights once per observation and constructs the final JSON once. The existing accepted-hand parser and public interfaces remain unchanged. All observations, game contexts, actor eligibility, ordering, decay, concurrency and permissions are preserved.

The new migration requires independent protected merge and exact-byte installation before the tonight engine window proceeds. Original installed migrations must not be replayed. Native qualification retains the full ten-player horizon and 1,500 ms limit, compares all final counters against the independent TypeScript implementation, and compares the internal counters with the canonical parser for recorded and malformed inputs. Mac measurements are evidence for that host only; required hosted qualification remains authoritative.
