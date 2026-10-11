# tests/a-chip-request-approval-key-belongs-to-its-approver.db.law.test.ts

fn_respond_chip_request keys its send by the request AND the approver (migration 20261010003544), so an approver refused by the exact-intent gate's first-actor binding (an agent with no float) never leaves the request unapprovable by the owner, a co-owner or an admin; a retry by the same approver still replays, an approval made under the old request-only key still replays, and the send and the status change commit together under the request's row lock.
