# Lightning Financial Witness Refusal Diagnostics

The one-intent financial witness previously retained an add-on request identity but reduced every refused response to `addon_refused`. It now records request/response observation timestamps, bounded HTTP status, an explicit boolean success (or unknown), and a static classification for exact maintained player messages: live Lightning hand, maintenance, maximum buy-in, absent seat and insufficient balance. Other content is `UNCLASSIFIED`; raw errors, bodies, credentials and card data are never retained.

This changes diagnostics only. Existing UI actions, timeout budgets, cleanup, authoritative money proofs and refusal outcomes are preserved. It adds no action, retry or financial write. The regression exercises normal refusals, malicious suffixes and non-string errors through the full witness, preserving exactly one request and local cleanup.
