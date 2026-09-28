# tests/a-permit-that-never-reached-the-database-does-not-hold-the-bank.law.test.ts

A stopped engine's attestation of the one permit it never started releases that
permit even when the database holds no row for it, because its
fn_f06_begin_hand reply was lost and the begin never committed. The park looks
for the row again only after taking the tournament lane the begin commits under
(before the retired-origin try-lock), releases it only with the caller's
generation and only when no durable witness of a hand exists at the attested
number, and records the release once in smarter_private.f06_absent_permit_releases;
a replay of the same shape answers the same release and any other shape is
refused. fn_f06_begin_hand refuses a recorded permit after f06_prefix, so a late
begin can never start that hand. The migration's pre-image is the previous
reviewed body of each function and its post-image is exactly the body it installs.
