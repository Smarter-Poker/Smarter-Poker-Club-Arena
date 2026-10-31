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
