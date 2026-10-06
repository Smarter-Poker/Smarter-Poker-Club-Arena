# Isolated authenticated EV cashout lifecycle

This fixture qualifies the real engine HTTP insurance handler, genuine GoTrue
sessions, the compiled HandController/ServerTableEngine, retained hand submission,
atomic settlement, post-commit insurance transaction, bank ledger and replay.
Two deterministic physical decks exercise a favorite that loses and one that wins.
Unauthorized and wrong-player acceptance and duplicate acceptance must refuse.
The locked payout, actual bank delta and fees must conserve both opening stacks.
Replay cannot add a receipt, payment or ledger movement.

The existing `component-fixture-native-smoke.yml` builds its pinned native image
and runs every existing smoke assertion first. Its owning driver then invokes
`run-native.py`, which uses that exact image in a separate network-none container.
Only reviewed actor files, generated catalog SQL and the freshly compiled engine
with locked server dependencies enter the read-only mount. No production data,
credentials, checkout, Docker socket or external service is accessible inside it.
The container is removed and its absence asserted on success and failure.

`captured-authorities.json` contains definitions and relation metadata only,
captured read-only on 2026-10-06. The sixteen critical function bodies and owners
are independently read back after loading. Supporting application relations use
the maintained full-weekly-accounting catalog; genuine GoTrue migrations create
Auth. Only relevant seat identity and ledger triggers are installed. This is an
EV-specific qualification, not a complete restored application, managed platform
privilege-parity certificate, browser/WebSocket certificate or full draft4353
qualification. Other runtime services and unrelated business triggers are outside
this case. Synthetic opening funds exist only in its disposable database.

The actor emits fixed stages for preparation, offer, authentication, acceptance,
duplicate refusal, commit, conservation and replay. Receipts omit raw SQL, logs,
headers, tokens, request bodies and environment. `product_certificate` stays
false; a passing lifecycle is evidence only for the named EV boundary.

Local composition/syntax/compiler checks are prerequisites. Genuine service
execution requires the maintained Linux amd64 Docker image. A local machine
without that runtime must retain this distinction and use the existing hosted
check, never replace authentication or settlement with a passing mock.
