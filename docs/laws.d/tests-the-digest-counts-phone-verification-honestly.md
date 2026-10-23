# tests/the-digest-counts-phone-verification-honestly.law.test.ts

The Smarter.Poker daily digest (2026-10-23) counts phone verification codes sent from the durable sms_otp_send_log (never from sms_otp_codes, whose rows are deleted on use), measures phone_verification_low against players who can still earn the welcome package by phone (US, not already paid by hand), warns on any failed send, and the Club Arena hamburger re-offers the welcome package to an unverified player.
