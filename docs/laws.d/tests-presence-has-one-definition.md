# tests/presence-has-one-definition.law.test.ts

"Online" has one definition in the Club Arena client: the presence door,
fn_profile_presence (profiles.is_online AND a last_seen heartbeat under five
minutes old), which treats a horse and a person alike now that horses keep a
real heartbeat (migration 20261005174041). The raw flag was true on 768 of 927
human rows and 442 of 1,000 horse rows on 2026-10-05 with no fresh human
heartbeat, and a Realtime presence channel only people can join was a second
definition that told a person from a house player. The law pins that no read
of profiles names is_online (select, embedded select, filter or order), no
realtime payload on profiles decides presence, no client code judges freshness
from last_seen, only src/lib/ownProfile.ts calls the door, the shared watcher
(src/lib/profilePresence.ts) re-asks every watched account in one batched call
inside the five-minute window and turns an unreadable answer into offline, and
every surface that shows a person online asks through it.
