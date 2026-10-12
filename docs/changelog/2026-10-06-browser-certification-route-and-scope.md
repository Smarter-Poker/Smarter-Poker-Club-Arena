# Browser certification follows the actual request and ledger scope

The gameplay appearance certificate registered its broad RPC handler after the
specific persistence handler. Continuing an unmatched request sent it directly
to the network, so the persistence gate never observed the request and the
certificate exhausted its deadline. Unmatched RPCs now fall back through the
registered handlers. The real authenticated persistence request and all durable,
realtime and immediate-paint assertions remain required.

The settlement ledger now returns club_id as part of its scope evidence. The
achievement observer certificate checks that exact projection while retaining
its club filter, successful response and rendered-ledger assertions.

These changes repair two failures from browser run37459888614. The Financial
Admin font/read-only guard and ordered Club Data migrations remain owned by the
active DATA PAGE delivery; this change does not duplicate those repairs or claim
a full production certificate.
