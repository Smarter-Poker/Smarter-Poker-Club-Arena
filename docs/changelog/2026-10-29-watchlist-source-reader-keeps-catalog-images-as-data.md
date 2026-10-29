# Watchlist source reader keeps catalog images as data

PR #8678's client shard 4 failed because the watchlist law used substring matching across frozen catalog JSON and expected-definition literals. It treated the stored old function images as new executable watchlist definitions and reported an imaginary narrowing at migration 212530.

The law now reads actual top-level declarations with the existing SQL lexer, in the original ascending migration order. Every prior membership and monotonicity assertion remains. Catalog JSON, assertion literals and comments cannot become declarations. Ambiguous dynamic watchlist DDL and malformed declarations refuse explicitly. Regression cases prove real narrowing remains visible, catalog/literal/comment data is ignored, and dynamic/malformed declarations refuse.

Validation: the ten affected law tests and TypeScript pass locally. No SQL migration, production function, watchlist member, wallet, ledger or financial invariant changes.
