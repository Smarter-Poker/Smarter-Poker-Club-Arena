# Manual MTT paid depth reaches creation and saved schedules

The form built an initial ladder for the chosen percentage but omitted
payoutPercent from its mapped configuration. The database then stored its10%
default and used that value at entry closure. The form also offered12.5%, which
the existing database depth contract cannot represent.

The engine now owns the supported10/15/20% option catalogue used by the manual
form and scheduled creator validation. The actual mapper carries the choice
through TournamentService into both one-off creation and saved schedules. Old
payout1 and payout3 keys retain their10% and15% meaning. The new20% choice is
explicit. Unsupported restored choices remain visible and require a supported
selection before creation; preview handles them without crashing. Switching the
new20% MTT choice to SNG likewise requires a supported SNG choice. No existing
event, schedule, template or financial row is rewritten.

The integration test exercises the rendered selector, actual mapper, RPC
serializer and schedule service. The previous enabled-options fixture used an
invalid gameMode and configuration shapes behind an unsafe cast; it now uses a
real, type-checked MTT form input. Existing SNG mappings remain covered.

Native qualification runs44 wrapper groups, including13 against the currently
installed creator body876158c293c3fe31d6857ba00ee33938 (captured14:48UTC).
Authorization and delegated creation are explicit stand-ins; no real registration
charge, whole creator transaction or terminal journey is claimed. The native
test is wired into the existing accounting CI job. Client/engine tests and
TypeScript results are recorded in MIGRATION-CHANGELOG.md. Protected CI, full
bundle and live adoption remain unqualified.
