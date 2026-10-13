# Recorded migrations trust the official provider CA

The strict TLS applier refused the finite inventory installation because its workflow supplied no provider trust root. The existing workflow now explicitly supplies the official public Supabase CA, pinned by provenance and a maintained law covering its hash, CA signature, expiry, absence of private keys and strict transport wiring. The applier, atomic history recorder and migration bytes remain unchanged.

Local certificate validation and focused law passed. Protected delivery and configured-endpoint TLS acceptance remain pending; no production SQL was executed by this source change.
