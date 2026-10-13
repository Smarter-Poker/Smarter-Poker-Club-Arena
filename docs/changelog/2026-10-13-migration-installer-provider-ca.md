# Migration installer provider CA

Installation run38330360060 refused the Supabase database's certificate chain
before connecting or applying SQL. The installer now defaults to Supabase's
public production Root2021 CA only for strict database and AWS pooler hostnames.
The public certificate comes from the Dashboard SSLConfiguration custom-content
URL, https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt.
Its SHA256 certificate fingerprint is
807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa.

Explicit argument, PGSSLROOTCERT and connection URL certificate precedence are
preserved, including explicit system trust. Other databases keep system trust.
Certificate verification and Node's default hostname checks stay enabled.
Offline tests cover the trust anchor, validity, host boundaries, precedence and
wrong-host refusal. They do not certify a hosted database connection or SQL
installation; protected delivery and the original one-time installer remain
required. No certificate or financial guard is disabled.
