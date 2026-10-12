# Lightning Pilot Preserves Seeded Games

The first authenticated setup created the private pilot club correctly, then
stopped before creating a pilot game: ordinary club provisioning had already
seeded nine Classic games. The setup incorrectly assumed a newly created club
had no cash games. The persisted creation request and club were recovered; no
club creation was repeated and no seeded game was changed.

Pilot discovery now selects only the exact named private six-seat NLH pilot
inside the verified club, leaving normal seeded games untouched. It refuses
ambiguous, wrong-club, public or already active targets. Missing targets use the
existing authenticated creation path, and unknown acknowledgements recover the
same durable target among the defaults. The original operation IDs remain.

The regression uses nine default games, verifies no mutation/adoption, recovers
the named pilot, and refuses unsafe candidates. It runs in the normal client
suite and the retained native operator qualification. No migration replay,
engine replacement, participant creation or financial fixture is introduced.
