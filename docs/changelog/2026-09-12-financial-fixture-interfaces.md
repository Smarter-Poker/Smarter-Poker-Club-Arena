# Financial Fixture Actors And Fixed Observations

The isolated release fixture can now opt into a single-hand top-up and insurance actor sequence. It uses authenticated HTTP requests and the engine's normal action contexts: malformed top-up refusal, one valid operation and exact replay, ordinary turn all-in play, and preview/refusal/acceptance of an observed insurance offer. Checkpoints must complete before the actor continues; a missing eligible offer or failed checkpoint stops the sequence.

The private observation protocol adds fixed financial reads bound to the fixture's two actors, one table, one operation key and one newly dealt hand. Replies contain selected database facts with finite deadlines and row/byte limits. Callers cannot supply SQL or a passing verdict. An optional canonical seed setting enables insurance through the normal game-creation options and verifies top-up headroom.

These are interfaces for a pending independent financial verifier. The ordinary fixture mode remains the default. HTTP success, injected test events and a `hand_complete` event do not qualify wallet effects, settlement, the complete schema or production delivery. The independent coordinator and genuine Auth/engine funded-route execution remain separate work.

Validation: native loopback HTTP/WebSocket and protocol refusal tests, PostgreSQL 17 fixed-reader isolation tests, and the canonical seed against a disposable application-schema database. The seed test uses synthetic Auth rows and does not certify the Auth service.
