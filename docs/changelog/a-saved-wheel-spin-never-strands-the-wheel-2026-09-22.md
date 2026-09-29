# A saved wheel spin that cannot be read never strands the wheel (2026-09-22)

`readWheelPending` threw when the saved spin in localStorage could not be read
back (corrupt JSON, a shape this client does not send, or storage that refuses
reads). The wheel page reads it on every load and its load now retries by
itself, so one bad save left the wheel on "Reconnecting To The Wheel" for good,
across sessions, behind a "Contact Support" error nobody saw.

The reader now discards an unreadable save, reports it, and returns nothing. That
is money-safe: a wheel spin settles atomically on the server (the debit and the
prize in one transaction; a won game becomes a pending award the wheel reopens),
so dropping the save loses only the reveal animation.

Pinned by `tests/unit/wheelPendingSpin.test.ts` and a case in
`tests/a-saved-round-settles-itself.law.test.ts` (owner ruling 2026-09-21:
nothing may make a player check or recover anything).
