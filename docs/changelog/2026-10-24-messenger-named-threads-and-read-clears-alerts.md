# 2026-10-24 - Messenger: named threads only, reading clears alerts, no welcome to probes

Dan: unread messages always on top, the counter disappears once messages are
read, remove every "Unknown" message, and new players always have a name.

## Measured

- 435 one-to-one threads had no other participant; 433 were the agent welcome
  from player #1 to post-deploy certification probes
  (`ca-customization-cert-postdeploy-%@example.invalid`) that joined the owner's
  club and were deleted a median 52 s later. Deleting the probe removed its
  participant row; `fn_get_user_conversations` LEFT JOINed the missing person
  and still listed the thread, which rendered as "Unknown". Player #1's inbox:
  534 threads, 433 nameless.
- All 4 unread `new_message` notifications belonged to threads already read:
  `fn_mark_messages_read_through` never touched notifications.
- Of the 153 surviving welcome recipients, none is certification equipment;
  4 live probes were.

## Fixed at the root (migration 20261024200633)

- The welcome trigger skips `fn_ca_is_cert_account` accounts, so probes stop
  receiving welcomes. Horses are never equipment and keep theirs.
- The inbox reader lists and counts a one-to-one thread only while the other
  profile exists, and names it display name, username, alias, then
  `Player #<number>`. `full_name` (column-protected real name) is never used.
- The read receipt marks that thread's `new_message` alerts read up to the
  first still-unread message; a one-time update cleared the 4 stale ones.

No rows are deleted. Client half (unread-first ordering on every Messenger
surface, no "Unknown" fallbacks): Smarter-Poker-World-Hub #2562.
Pinned by `tests/the-inbox-never-shows-a-nameless-thread.law.test.ts`.
