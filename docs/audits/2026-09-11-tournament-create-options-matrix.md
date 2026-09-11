# Tournament Create Options Matrix

Captured client calls: 91. Distinct RPC payloads: 58. Duplicate captures: 33.

This is a reproducible option-coverage map. It does not claim native persistence or browser acceptance.

| RPC Option             | Candidate Database Columns    | Distinct Captured Values  |
| ---------------------- | ----------------------------- | ------------------------- |
| acceleratedMtt         | accelerated_mtt               | acceleratedMtt: 1         |
| actionTimeSeconds      | Requires source-local review  | actionTimeSeconds: 3      |
| addOnAvailable         | add_on_available              | addOnAvailable: 2         |
| addOnChips             | addon_chips                   | addOnChips: 2             |
| addOnCost              | addon_cost                    | addOnCost: 10             |
| addOnFromStart         | Requires source-local review  | addOnFromStart: 1         |
| addOnLevels            | addon_levels                  | addOnLevels: 1            |
| addonBreakMinutes      | Requires source-local review  | addonBreakMinutes: 2      |
| allInOrFold            | all_in_or_fold                | allInOrFold: 2            |
| authorizedToRegister   | authorized_to_register        | authorizedToRegister: 2   |
| banChat                | ban_chat                      | banChat: 2                |
| bigBlindAnte           | big_blind_ante                | bigBlindAnte: 2           |
| blindStructure         | Requires source-local review  | blindStructure: 6         |
| bountyAmount           | Requires source-local review  | bountyAmount: 2           |
| bubbleProtection       | bubble_protection             | bubbleProtection: 1       |
| buyIn                  | Requires source-local review  | buyIn: 9                  |
| earlyBirdChips         | Requires source-local review  | earlyBirdChips: 1         |
| earlyBirdEnabled       | early_bird_enabled            | earlyBirdEnabled: 2       |
| finalTableDealEnabled  | final_table_deal_enabled      | finalTableDealEnabled: 1  |
| freeBuy                | Requires source-local review  | freeBuy: 1                |
| gameVariant            | game_type                     | gameVariant: 8            |
| guaranteedPrize        | guaranteed_prize              | guaranteedPrize: 2        |
| hideClubName           | hide_club_name                | hideClubName: 2           |
| isFeatured             | is_pinned                     | isFeatured: 2             |
| isMultiDay             | Requires source-local review  | isMultiDay: 1             |
| isPrivate              | Requires source-local review  | isPrivate: 1              |
| isRebuy                | is_rebuy                      | isRebuy: 2                |
| isReentry              | is_reentry                    | isReentry: 2              |
| isVipOnly              | is_vip_only                   | isVipOnly: 2              |
| isXmtt                 | is_xmtt                       | isXmtt: 1                 |
| labelAsNew             | label_as_new                  | labelAsNew: 2             |
| lateRegistrationLevels | late_reg_levels, rebuy_levels | lateRegistrationLevels: 2 |
| maxPlayers             | Requires source-local review  | maxPlayers: 9             |
| maxRebuys              | Requires source-local review  | maxRebuys: 1              |
| maxReentries           | Requires source-local review  | maxReentries: 1           |
| minPlayers             | Requires source-local review  | minPlayers: 6             |
| name                   | name                          | name: 1                   |
| payoutStructure        | Requires source-local review  | payoutStructure: 12       |
| rebuyChips             | rebuy_chips                   | rebuyChips: 1             |
| rebuyCost              | rebuy_cost                    | rebuyCost: 9              |
| restartEveryMinutes    | Requires source-local review  | restartEveryMinutes: 1    |
| satelliteSeats         | Requires source-local review  | satelliteSeats: 1         |
| satelliteTargetId      | Requires source-local review  | satelliteTargetId: 2      |
| shortDescription       | short_description             | shortDescription: 1       |
| spinType               | spin_type                     | spinType: 2               |
| startTime              | Requires source-local review  | startTime: 2              |
| startingStack          | starting_chips                | startingStack: 1          |
| synchronizedBreaks     | Requires source-local review  | synchronizedBreaks: 2     |
| tableSize              | Requires source-local review  | tableSize: 5              |
| type                   | Requires source-local review  | type: 5                   |

## Native Extension Assertions

1. Reuse the existing authenticated create fixture and caller session. Classify each representative payload against its original test expectation before native use; captures include helper calls and do not record acceptance/refusal labels. Original duplicate client calls do not add native coverage.
2. Confirm the current creator hash matches the selected tracked definition. For each option, compare the actual row or nested configuration with the captured RPC value after documented server normalization.
3. Check every nondefault captured value, nested configuration, enum, and boundary represented by the original client tests. Treat single-value options as unvaried coverage.
4. Compare MTT, SNG, and Spin rows separately and confirm unsupported settings are refused or explicitly normalized. Do not infer success from an unused JSON key.
5. Preserve the root create/edit permission and immutable-money probes. This option extension should not repeat funded entry, payout, or final-deal proofs.
6. Execute under one outer rollback and require exact business-table/catalog restoration.

## Limits

- No database or browser execution. Static candidate mappings are not proof of persistence.
- Zero or one observed value does not prove an option works for all allowed values.
- A missing direct creator read is a review candidate, not a defect: delegated functions and normalization may handle it.
- Captured unit-test calls do not record expected acceptance/refusal labels; do not assume all 58 distinct payloads are valid event creations.
- Display bindings span full shared pages, including cash-only controls; variant visibility needs source-local classification.
- Visible controls with compound expressions or spread properties require source-local review; this parser records static property dependencies only.
- The selected tracked creator definition must be confirmed against the current deployed function before claiming current-server coverage.
