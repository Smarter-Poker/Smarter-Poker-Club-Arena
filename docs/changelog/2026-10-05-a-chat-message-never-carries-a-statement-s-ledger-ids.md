# A chat message never carries a statement's ledger id list (2026-10-05)

**Symptom.** In the World Hub Messenger Club Arena drawer, the Deep Stack Society Accounting thread stuck on "Loading Messages..." and then failed. `/api/messenger/get-messages` returned 503 "Messenger State Unavailable" each time it was opened (21:53:22, 21:54:29 and 21:55:04 UTC).

**Cause, read from production.** Weekly Club Statement CA-2026-00000608 (Deep Stack Society, week starting 2026-09-21) was delivered with `lines.private_bank_ledger_ids` in its `media_metadata`. That list covers about 197k ledger ids and takes up 8.7 MB of the message. `fn_messenger_continuity_window` builds the page with `jsonb_agg(to_jsonb(m))`, which took 27-32 s on that one row. Service role's statement timeout is 8 s, so the request was cancelled every time. `fn_deliver_accounting_invoice` copies the breakdown minus `source_ledger_ids`. The second list, added to the statement on 2026-09-28 (`20260928164258`), was never added to that exclusion.

**Fix (`20261005222016`).**
- The delivery now excludes both id lists from `lines`.
- `fn_messenger_message_page` and `fn_messenger_search_messages` drop both lists from what they return, so delivered messages stay immutable and still load. The page drops from about 30 s to about 14 ms.
- The three notifications that carried the list lose that one key.
- The invoice breakdown stays untouched and remains the record.
- No money moves.

**Pinned by** `tests/a-chat-message-never-carries-a-statement-s-ledger-ids.law.test.ts`. If a statement adds a new `*_ledger_ids` list without widening the delivery and both readers, the test fails.

**Not changed.** Conversation `a6a54601-9c3a-4db6-8e1b-cf4bd0377f40` holds a second copy of the same statement message. Created in the same transaction as the delivery, it has no `accounting_conversations` or delivery row, so Messenger lists it under the club's Messages tab instead of Invoices. With this fix it loads, and the reader shows it as plain text, not as a verified invoice. Why the copy exists is a separate question and is out of scope here.
