# Phase 16 Acceptance: Cash Spectator Selection

Production run 34481209943 reported no eligible occupied cash fixture. Its
retained WebKit page snapshot instead shows SHARK CLUB with occupied running
cash games, including 4-player and 3-player FLH games and a 2-player FLO8 game.
Their read-only controls say View Game.

The certificate excluded these cards twice: it required data-target=table,
while clustered cash cards use data-target=game, and it recognized only View
Table or Watch Table. ArenaLobbyGameCard retains the representative table's id
in data-id for both variants. ClubHomePage's cash onViewTable handler warms and
navigates directly to that same table id without join state.

The selector now accepts both cash presentation variants and the corresponding
View/Watch Game labels. Selection and the later click share the same action
pattern. Disabled controls are rejected as well as hidden and zero-size ones.

The pre-navigation engine checks still require exact release identity,
normal dealing, an existing occupied/dealable cash table and advancing hands.
The post-navigation route match, causal hand cycle, no-participation-mutation
checks, real offline/reconnect and exactly one transport remain unchanged.
The fix does not create a fixture or claim those gates have passed.

## Verification

Two cluster-card cases failed against the old selector. All 15 candidate
selection cases now pass, including manual tables, refusal of join/waitlist
controls, insufficient occupancy, wrong format/target, non-live cards and
inaccessible actions. The three existing all-format certificate guards also
pass. Playwright collects all four WebKit continuity cases successfully.
Production execution remains required after publication.
