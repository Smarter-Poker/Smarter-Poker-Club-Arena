# tests/an-account-closes-without-touching-the-books.law.test.ts

Walking the app for store review on 2026-09-29 found that nobody could delete
their account: Settings, Close Account, Close My Account answered 500, and so
did the World Hub's settings page, because both call the World Hub's DELETE
/api/auth/delete-account. It hard-deleted rows with the service role and then
the Auth user, and the database had made that impossible twice over: the
service role cannot write cashout_requests, and every account is born with an
append-only journal row that a hard delete of profiles or auth.users cascades
into and is refused. App Review 5.1.1(v) and Google Play require in-app
deletion. public.fn_close_account now closes the account in one transaction
and the World Hub soft-deletes the Auth user. This law holds the definition in
force to what made that work: every settlement check comes before the first
write, so a refusal changes nothing; the rows the journals hang from are never
deleted and no balance column or journal is ever written; clubs are left
through the lifecycle door and the membership rows are kept; only service_role
may call it and the money guard knows it moves no money; and its refusal
reasons are exactly the ones the World Hub answers with an instruction.
