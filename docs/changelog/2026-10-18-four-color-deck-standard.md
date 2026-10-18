# Four-color deck is standard and shares the settings store

The table switch could show ON after account hydration while cards without an explicit deck prop kept their earlier two-color cached value. `useDeckStyle` now subscribes directly to the canonical store, including hydration, instead of keeping another localStorage/bus cache. Cards respond even if a bus message is dropped.

Four colors are the default in the table store, account bridge, panel reset and image-path helper. A local explicit-choice marker distinguishes deliberate new opt-outs from the former full-object persisted OFF default. Server `settings_touched` restores explicit account choices, including OFF, and retains their local marker. The database migration changes only the default and untouched OFF rows; deliberate account choices survive. Broken-image text fallback now follows the selected deck too.

Verified source and connected controls: SettingsPanel -> TablePage updateSetting -> shared store -> direct subscribers; SettingsPage Save -> toTableSettings -> same writer; account hydration -> shared commit -> card readers. No engine changes or new engine contract.

Regression suite reproduced all five failures against the unchanged base, including ON at the switch with a still-two-color card after account hydration. All five pass after the fix. Focused settings/card tests: 85 passed. Local PostgreSQL 17 fixture verified new rows and legacy untouched rows ON, chosen OFF preserved, chosen ON preserved, and harmless replay. Compiler and required hook/provider/publication results are tracked in CHECKPOINT-four-color-deck.md.

Real-time law: preference changes use the existing SETTINGS_CHANGED event and direct canonical store subscription; no gameplay snapshot diff or polling.

The cross-tab storage fallback now also enters the canonical store, so a browser without BroadcastChannel updates both explicit table props and implicit cards. Account ownership prevents another account's cached choice from being adopted. Two additional regressions cover those cases.

Account hydration also rejects a different account's local deck opt-out when the new account has no chosen deck. Both absent-row and default-row cases failed before the correction and pass afterward.
