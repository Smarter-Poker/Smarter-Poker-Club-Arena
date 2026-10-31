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
