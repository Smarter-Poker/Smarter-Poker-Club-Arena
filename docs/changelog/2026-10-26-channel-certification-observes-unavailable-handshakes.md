# Channel Certification Observes Unavailable Handshakes

The lifecycle verifier previously reported every pre-upgrade channel failure as “Channel open failed.” It now retains only numeric CDP handshake status and socket close code, including when certification fails. Headers, bearer protocols, tokens, traces and raw transport errors remain excluded.

Only an explicitly observed HTTP 503 followed by abnormal pre-upgrade close 1006 permits another attempt: at most three attempts, bounded open/close deadlines and 500 ms between attempts. Unknown transport failure, other HTTP status, successful upgrade and protocol denial never authorize a retry. Failed sockets reach close before another attempt; successful positive-control sockets also finish closing before the next connection. All club-membership, private-frame absence, PONG, cache-expiry and positive-control assertions remain unchanged.

Local real HTTP/WebSocket fixtures cover 503 then 101, permanent 401 and exhausted 503s. Additional cases refuse unknown and post-upgrade/denial outcomes and confirm diagnostics omit an authentication sentinel. Historical production failure status remains unknown; this verifier change does not establish that it was a 503 or replace fresh live certification.

Real Chromium rejects HTTP503 without a handshake-response event. Its request-correlated frame-error event now passes through an anchored known-format numeric parser; no raw message is retained. A local zero-auth Chromium probe importing the maintained parser confirms status503/close1006. Unknown formats and messages containing trailing sensitive text grant no retry.
