# A seat timeout does not authorize a cash fallback

The original satellite award method used any seat RPC error as a reason to pay cash. A lost response can occur after the seat commits, so that fallback could deliver both a seat and cash. Missing or ambiguous receipts also fell through to a confirmed seat log and prize stamp.

The original method now throws on transport uncertainty and malformed receipts. Cash fallback still requires an explicit refusal, or an explicit statement that the seat was held from elsewhere. A confirmed new seat or same-satellite replay pays no cash. The finish caller stops on an award exception instead of continuing to COMPLETED.

Executable regressions run the actual award method and finish handoff with scripted I/O. Seven of twelve cases failed before the correction; all twelve now pass, along with server TypeScript and all 6,580 server tests across 465 files. This is a bounded receipt/finish correction: automatic resumption, cash partial-payment handling, read-error returns, weak any-record recovery completion, and atomic seat funding remain outstanding satellite audit work. No new replay process or wallet path is added.
