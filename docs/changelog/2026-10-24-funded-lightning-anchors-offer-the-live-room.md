# Funded Lightning anchors offer the live room

An existing player could remain on a halted physical Lightning anchor with Seat Reserved showing, even while their own pool session was actively dealing. The View Game offer was gated on a positive hero stack in the public physical hand roster. That stale roster can omit the funded player, so the offer never queried the existing session.

The original seat lookup now retains account/table-scoped funding truth separately from the public hand presentation. The existing conversion handoff uses that truth, including known empty and leaving-seat refusals, and an acknowledged local departure overrides an earlier funded read. The authenticated session RPC still decides whether the caller owns an open room anchored at this exact table. Navigation still requires the existing explicit View Game gesture; embedded tables use the same existing handoff callback.

The original Join Lightning intent and newly purchased-seat handoff retain their prior gate. No new query, poller, purchase, custody operation or engine API is introduced. This client repair is compatible with the serving engine and can publish independently.

Regression tests execute the actual TablePage funding/input expressions and mount the actual handoff hook. A funded anchor whose public roster omits the hero enables View Game; empty, leaving, unfunded and other-account anchors do not. Both ordinary and embedded navigation wait for the gesture. Three cases fail against the original source. Existing Lightning entry/session tests remain enforced.
