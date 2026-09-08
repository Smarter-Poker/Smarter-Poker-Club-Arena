# Rabbit Hunt retries reuse the committed purchase

Date: 2026-09-08

The engine called fn_consume_rabbit_hunt, whose compatibility wrapper generates a
new request UUID each time. If payment committed but the response timed out, the
in-memory revealed set remained empty and a retry could charge again.

The engine now calls the existing service-only fn_consume_rabbit_hunt_v2 with a
UUIDv5 derived from a versioned feature name, table, hand and player. Requests
replay the durable receipt after a lost acknowledgement. Different hands, tables
and players remain distinct. No extra round trip, automatic write retry, pricing
change, new dependency or database migration is introduced.

27 behavioral tests passed, including a committed payment with a lost response,
cross-instance identity, distinct purchase identities, denied eligibility, billing
failure, repeat taps and a stalled metadata insert. Server TypeScript passed.
Production v2 function was read and its service-only privileges verified without
making a purchase.

The earlier next-hand gap / Rabbit rendering change is PR #3641. Its live engine
adoption remains a separate required check. This fix prevents another charge after
an ambiguous response; it does not make a failed network response instantaneous.
