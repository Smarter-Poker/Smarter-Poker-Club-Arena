# tests/a-chat-message-never-carries-a-statement-s-ledger-ids.law.test.ts

Every `*_ledger_ids` list a weekly club statement emits stays on `settlement_invoices.breakdown`: the newest `fn_deliver_accounting_invoice` excludes each one from the `lines` it copies into the Messenger message and notification, and the newest projection of `fn_messenger_message_page` and `fn_messenger_search_messages` strips each one. On 2026-10-05 an 8.7 MB `private_bank_ledger_ids` list in one statement message made its thread time out (503) on every open.
