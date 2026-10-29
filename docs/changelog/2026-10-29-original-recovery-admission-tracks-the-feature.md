# Original recovery admission follows its exact feature

The intervening protected Lightning release served `a1eca34258811c462bf8ce7cda8bd18df090cf1b`, which contains the shared `ac6a6207042e7671a22803b6e127dbe36afd8e0e` base but has never contained the durable continuation migration. The prior base-only one-use check therefore treated the still-unshipped recovery feature as consumed.

The existing recovery window now uses the already-qualified `releaseWitness` mechanism with `20261028233353_durable_private_hand_continuation.sql` and its exact SHA-256. Both the existing stage admission and host transaction require exact target bytes and full serving history. Changed, missing, shallow, unknown, served or later-deleted witnesses retain their existing refusal behavior.

The original October 29 01:40–07:40 UTC window, minute 53 announcement, two-minute notice, five-minute pause, full 285-second proof and rollback reserve, protected source, ordered database prerequisites and single activation remain unchanged. No runtime, SQL, workflow, publisher or recurring work is added.

The maintained daily-admission law failed before the carrier correction because the actual entry had no witness. It now pins the exact source hash and unchanged bounds; existing producer and real host-transaction witness tests cover admission and all refusal cases. Protected delivery and live activation are separate acceptance steps.
