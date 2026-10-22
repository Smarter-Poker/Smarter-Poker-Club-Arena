# Lightning Witnesses Act Only On The Selected Pool

Restored multi-table sessions can show several Lightning games at once. The player, cycle, latency, financial and recovery witnesses now share one helper that selects the exact pool tab through the normal tab control, and every play or money control checks that the same pool is still selected immediately before its click. A changed or missing selection refuses the gesture and is reported as unknown; the witness never switches back on its own. Financial cleanup (I'm Back and Auto Top Up off) reselects the pool at most once and confirms the original cash session before acting.

Tooling only. No product, engine, database or money path changes.
