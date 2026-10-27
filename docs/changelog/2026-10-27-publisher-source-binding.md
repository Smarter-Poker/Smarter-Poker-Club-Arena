# Restore the publisher qualification source binding

Protected #8296 changed the unpaid-Lightning qualification workflow without updating its fingerprint in the original-retirement qualification. Publisher 40551988350 then failed its required client test shard: 10,820 tests passed and this source-binding assertion refused publication.

The reviewed workflow delta adds the treasury-seat-gift migration argument and two dedicated treasury native qualifications. Record its actual SHA256 74d5c808ad4350b5b955dbbce5b3d784462883a72488d316916f158817816928 and retain the audit note naming the protected source. Preserve every financial input, assertion and historical verdict. The fingerprint is not a new financial execution or installation certificate.

This independent metadata-only repair carries the same reviewed correction as the incident client/backend PRs. It requires normal source-contract checks and protected merge; no client behavior, engine activation or migration changes. Publication remains through the existing provider and requires actual live readback.
