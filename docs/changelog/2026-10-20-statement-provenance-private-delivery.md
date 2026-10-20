# Statement provenance stays on the invoice

The standalone weekly bank funding report adds native ledger and mint receipt arrays. The invoice delivery writer and both private Messenger readers now exclude these arrays alongside the existing statement provenance arrays. The invoice breakdown and issued message history remain unchanged; accounting amounts, audience checks, history-only weekly delivery and duplicate-delivery guards retain their original behavior.

Migration `20261020184651` pins all three original production definitions and their owner, ACL, security, volatility and search path before exact substitutions. It verifies all postimages atomically and refuses replay. These owners are outside the inventory source guard and guard watchlist, so no inventory generation changes.

The existing launch-reset PostgreSQL parent unconditionally exercises the actual writer and both original readers: original leak reproduction, sanitized delivery and legacy projection, preserved invoice provenance and amounts, duplicate refusal, authorization and ACL preservation, atomic postimage/authority faults and replay refusal. Unrelated contract/authentication dependencies are controlled fixture helpers. Production installation and exact catalog readback remain separate.
