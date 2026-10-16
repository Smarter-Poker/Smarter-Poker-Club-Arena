# Private Cash Join Membership

The private Lightning access witness reached a seat hold because `fn_cash_game_join` checked wallet coverage before private membership. Its wallet helper can select another club's wallet. Discovery and socket refusal did not prevent this separate join path. The witness cancelled its own hold through the normal cancellation door; independent readback found no remaining active hold, game waitlist or pilot membership.

The migration adds a private game or private club membership check before every existing seat, wallet, hold and queue branch. It permits the actual club owner or an active/approved member and preserves public admission and the existing Diamond session/custody safeguards. It refuses an unexpected function predecessor atomically. No balances are rewritten.

The isolated PostgreSQL witness exercises the actual predecessor function before and after installation, including an outsider whose other-club wallet covers entry, pending membership, owner/member access and public admission. The private access collector retains sanitized join outcomes and successful intermediate observations even when a later assertion fails. Actual production access must pass after protected integration, exact installation and independent readback; local checks alone do not qualify the pilot.
