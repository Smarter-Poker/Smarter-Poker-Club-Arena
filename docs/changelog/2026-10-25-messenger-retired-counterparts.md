# Retired Messenger counterparts

Soft-deleted sign-in accounts can retain their ledger-backed profiles. Their reserved verification email is removed during retirement, so active certification classification stops recognizing them and their old welcome threads reappear. The direct inbox reader now excludes a counterpart whose authoritative authentication row is soft-deleted. It preserves groups and active users without inspecting the spelling of their names.

This is a guarded successor to installed migration 20261025185834; it does not edit or replay that migration. Authentication, public names, unread-first ordering, private invoice restrictions and function permissions remain intact. No account, message, read receipt or financial history is changed.

The maintained native Messenger regression now loads the exact installed preimage into a second PostgreSQL database and reproduces the retired-account leak before applying the successor. It verifies retired counterparts disappear while active users, group threads, unread order and stored identities/history remain correct. The existing required CI step executes both cases.
