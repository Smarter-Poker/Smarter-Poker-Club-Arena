# Open wallets read the money that moved

The cashier, wallet panel and Table Management were subscribing to tables that
the billing-related publication trim deliberately excludes. Successful channel
joins could never deliver another operator's changed balance or managed game.

These views now read existing authenticated, permission-aware sources only while
open and visible. Wallet reads follow an eight-second interval, with immediate
reads on return and after local commands. Concurrent wallet panels retain their
shared requests. The management feed follows the board's existing twenty-second
budget and reads at most 128 compact rows through its existing scope index. A
full window invokes the authoritative board/access read; overlapping reads also
observe transactions whose sequence was allocated before a later commit.

Reads cannot overlap, closed/hidden/offline views do not start requests, and a
scope change discards late replies. Requests have bounded deadlines. A cashier
read failure renders Unavailable; the wallet panel preserves its last numbers
with its existing failure indicator. Club and union money remain separate, and
diamond-only arenas still issue no chip queries. Money commands, transaction
guards, gameplay sockets, horse treatment and database publication are unchanged.

Regressions exercise actual cashier and wallet components, feed delivery and
scope/error/visibility boundaries. Before the source correction, four cashier
cases, four wallet cases and the six original management-feed cases fail. The
source guard for both promo accounts now follows their extracted read helper;
the obsolete channel-reconnect pins now forbid those dead subscriptions and
require the bounded shared read instead. No assertion about wallet separation,
permissions or transactions was removed.

This changes request cost, not an invoice already issued. Each visible cashier
reads one or two narrow rows per interval; a wallet panel reads its four existing
sources (one for a diamond-only arena), with in-flight deduplication. No savings
amount is claimed from source tests, and production publication and behavior
verification remain separate evidence.
