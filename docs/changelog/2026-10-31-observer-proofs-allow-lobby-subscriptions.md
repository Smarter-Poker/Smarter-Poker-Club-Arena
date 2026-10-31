# Observer proofs accept lobby subscriptions

The published King spectator proof reached its seat-move assertions but refused
`JOIN_LOBBY` as participation. That frame only subscribes its own connection to
lobby counts; `LEAVE_LOBBY` removes the subscription. The row-owner proof had the
same omission.

Both maintained proofs now use one explicit observer protocol boundary including
these two read-only operations. Participation and unknown frames remain refused.
The controlled hero phase still refuses **every** upstream frame before this
allowlist is consulted. No game, seat, wallet or production runtime behavior
changes. Regression coverage binds the actual server handlers, both consumers,
negative participation cases and the stricter synthetic-phase ordering.

Live behavior remains unverified until the protected publication's actual
browser cases execute successfully. The broader MTT failure remains visible.

The next qualified live attempt (`41228826221` / `124618882581`) admitted the
lobby join but reached the same guard on `CHANNEL_PING`, before the controlled
hero phase. The complete maintained channel dialect is now checked: channel
ping/pong plus private-record, club and tournament subscription lifecycles are
accepted, alongside the existing table observer protocol. Their handlers only
manage authorized subscription/presence transport and read current presentation;
the private-record ACL RPCs and their called authorization functions were read
from the installed database and contain reads only. No persistent game or
financial writes are admitted. `UPDATE_PRESENCE` and `REQUEST_HAND_REPLAY` remain
refused because these proofs do not exercise them. The declared client channel
union is covered by the regression so another dialect omission is explicit.

The corrected channel boundary let the next live case reach and render the
synthetic hero through the served parser and mapper, with no immediate false
invariant diagnostic. Its refusal positive control then failed: the init script
had captured Playwright's native backing socket rather than the routed
application socket. An isolated real-browser reproduction showed that the old
harmless PING can bypass the proxy and reach the loopback server. The old live
probe may likewise have reached the engine; its zero proxy-forward counter
cannot certify that physical probe as blocked. This pointer was used only by the
verification probe, not by application traffic.

Remove the native pointer and exercise the real client's foreground handler
through a browser visibility event. The stricter synthetic guard still refuses
all upstream application frames. A maintained case in the existing lobby chrome
fixture suite uses the real EngineChannelClient, Chromium/WebKit, Playwright
interception and a loopback HTTP/WebSocket server. Ordinary lobby reads work;
the old native control demonstrates the bypass; the actual foreground control's
CHANNEL_PING and JOIN_LOBBY are refused; a nonread HTTP control is refused; zero
additional physical frames reach the local server; cleanup closes the context
while its guards remain armed. No production account, row or financial fixture
is involved in that regression. All deployed hero rendering, paint and diagnostic
assertions remain unchanged; final live acceptance is still required.
