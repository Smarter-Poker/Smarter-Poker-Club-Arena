# Live seats survive late table bootstrap

Production verification37381227013 reproduced two occupied SNG seats becoming empty for over ten seconds while its engine kept dealing. An obsolete identity-hydration metadata request resolved after the first socket snapshot and reset the ring. The later seat/profile restore could also replace newer engine state.

TablePage now refuses cancelled bootstrap replies and preserves the same table's engine-owned seats, positions, actions and bet amounts when metadata arrives late. A late database restore cannot overwrite the engine roster or hero seat. Pre-engine bootstrap still creates the configured empty ring. Blind changes delivered after the request began and the same-table final-table flag survive late metadata; database time-bank initialization preserves a known allowance and changed timer value while retaining fallback when the snapshot omits these fields.

Regression coverage executes the actual async bootstrap with a deferred metadata response and the actual database restore updater with a deferred profile response. The metadata and cancelled-effect regressions failed before the repair. Production deadlines remain unchanged. No engine or database mutation is required for this client correction.

The gameplay customization certificate now selects the existing accessible name "Open Table Studio", matching SettingsPanel's aria-label. Its former visible-text selector "Open Studio" could never match that role query.
