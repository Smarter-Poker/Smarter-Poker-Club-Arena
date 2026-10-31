# Isolated schema capture trusts the maintained provider CA

Protected diagnostic run41238331793 established the actual connection failure:
SELF_SIGNED_CERT_IN_CHAIN on the configured session-pooler route, before a
transaction or schema capture. The system-only trust configuration did not
establish the provider chain. No authentication failure or connected UI pass is claimed.

Reuse the existing official public CA at
scripts/ci/certificates/supabase-prod-ca-2021.crt, already maintained and used by
Apply Merged Migration. Pin its existing PEM SHA256 and use the same file for
Node certificate validation and pg_dump verify-full. The protected controller
also retains the certificate hash in its source closure. No credentials,
connection route, host, TLS hostname verification or production data change.
Missing or changed trust bytes refuse capture; there is no trust downgrade or
automatic retry. The corrected connected run must independently prove actual
endpoint TLS, full-schema parity, all14 cases and cleanup.
