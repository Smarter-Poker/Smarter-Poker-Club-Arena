# Must-Move: replacement seats and arena names

When a cash player leaves and rejoins between roster reads, the dealer now
recognizes the new occupancy. It retires the old stay's button eligibility,
entry debt, presence, time bank, straddle, pre-action, rebuy and stay-clock
mirrors before classifying the replacement seat. An unchanged occupancy keeps
its existing state. A roster read returned after loss of engine authority is
not adopted.

Live table names now follow the existing Club Arena naming rule used by the
Must-Move lobby: poker alias, then username, then a legacy nickname only when
it is not the profile's real name. This applies equally to horses and humans
and does not change the player's social naming preference. The service-only
profile fields used for comparison are not serialized into seated players.

Validation: replacement/unchanged/retired roster cases, embedded and fallback
profile queries, and a 96-profile parity matrix against the browser's arena
resolver. This change does not certify Phase 2 readiness; the independent
audit still tracks live settlement stalls and release verification.
