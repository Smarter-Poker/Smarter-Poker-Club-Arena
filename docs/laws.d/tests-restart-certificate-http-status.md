# tests/restart-certificate-http-status.law.test.ts

A degraded engine may carry its complete restart certificate in an HTTP 503
health response: the deploy reads that body only after a successful transport
and only for HTTP 200 or 503, then requires the same running, active countdown,
durability, readiness, zero-unparked-table, and three-minute predicates at both
the public gate and the locked localhost recheck; every other status, malformed
body, transport failure, or incomplete certificate fails closed before host
mutation.
