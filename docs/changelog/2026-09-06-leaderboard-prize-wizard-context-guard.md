# Leaderboard Prize Wizard Context Guard

## Fixed

- Prevented the hamburger-menu prize setup deep link from opening with a previously selected club's reward settings while the requested club is still loading.
- The wizard now opens only after its loaded settings record matches the club ID in the deep link.
- Added a release contract assertion that preserves this club-context gate.
- Split the ten-look Table Studio screenshot sweep into independent tests after the required browser gate exceeded its single-test timeout. The same thirty visual assertions now produce one bounded verdict per look.

## Verification

- Reproduced the mismatch on the published Leaderboard by switching from Deep Stack Society to Club JAQK through Owner Prize Tools.
- Confirmed the requested URL selected Club JAQK while the stale wizard header still named Deep Stack Society before this fix.
- Table Studio customization browser suite: 13 of 13 tests passed, including all ten coordinated looks and all thirty reviewed screenshots.
