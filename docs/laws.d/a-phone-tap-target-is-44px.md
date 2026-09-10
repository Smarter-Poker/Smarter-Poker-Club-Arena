# tests/a-phone-tap-target-is-44px.law.test.ts

The create-game row (GameCreationActions) restores 44px buttons where it
re-flows for a phone, and the lobby game panel close button (.glp\_\_close) is
44x44 at every width. Both were 30px dismiss/create controls on surfaces a
phone reaches (audit CL-31, CL-33); CLAUDE.md rule 6 is 375px first and the
minimum tap target is 44px.
