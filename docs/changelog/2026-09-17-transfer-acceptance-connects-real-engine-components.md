# Transfer acceptance connects SQL, both engines and socket replay

The existing PostgreSQL 17 accounting suite now composes the actual transfer and arrival functions, two real ServerTableEngine instances, their presence/time-bank engines, TableStateHub and EngineWebSocketServer over a loopback HTTP/WebSocket connection.

The first case commits while the executor response is lost, adopts the destination before the source reply, recovers the immutable receipt, retires the original runtime state, and reconnects after missing the event. Resync does not duplicate the delivered move. A voluntary sit-out keeps its original clock and strikes after heartbeat. The second case holds one swap side, commits both at the partner boundary, preserves each player's presence and seven-second remaining bank, and replays the other recipient's move.

Independent SQL counts retain 125 chips for the one-way transfer and 245 for the swap, with zero wallet/chip transactions and exactly one/two move receipts. Both new cases passed against socket-only disposable PostgreSQL 17 using maintained migrations; no production game or money was changed.

The native socket uses explicit synthetic identity and access fixtures. This establishes the real engine/socket chain, not GoTrue/RLS authentication or full TablePage browser navigation. Those remaining acceptance layers must be reported separately. The cases execute in the existing required accounting job; no new release stage or periodic test mechanism is added.
