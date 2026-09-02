# Retired test accounts (2026-09-01)

141 synthetic accounts deleted from production at Dan's explicit instruction, as
part of the VIP stipend investigation. This file is the restore record: every id,
username, email and diamond balance as it stood immediately before deletion.

## Why these 141 and not others

They were isolated as `vip_tier = 'lifetime' AND NOT is_horse` (the granted-VIP
human cohort, 162 accounts) intersected with
`email ILIKE '%@example.com' OR email ILIKE '%test%' OR username ILIKE '%test%'`.

Every one of the 141 was hand-checked against that pattern for a false positive.
There were none. The buckets:

| bucket                                                                                         | count |
| ---------------------------------------------------------------------------------------------- | ----- |
| `tester_<uuid>@test.com` and other test-prefixed                                               | 105   |
| `orb1_test_user_*@smarter.poker` (load rigs)                                                   | 12    |
| `@example.com` (orb4lead / orb4test / dbg / jetski)                                            | 8     |
| `god_<uuid>@test.com` (god-mode rigs)                                                          | 10    |
| `e2e_tester_*`, `antiabuse_e2e_*`, `verifier@test.com`, `finaltest2024`, `johnnyd.test.march5` | 6     |

The 21 non-test accounts in that cohort were left untouched, along with all
1,000 horses and the 12 monthly-tier humans.

## Blast radius, measured before deleting

Read-only counts taken against production:

| relation                         | rows for these 141 |
| -------------------------------- | ------------------ |
| `club_members`                   | 0                  |
| `table_seats` (any)              | 0                  |
| `rake_attributions`              | 0                  |
| `diamond_ledger`                 | 0                  |
| `hand_players`                   | 0                  |
| `hand_actions`                   | 0                  |
| `tournament_registrations`       | 0                  |
| `chip_transactions`              | 3                  |
| `player_stats`                   | 1                  |
| `wallets` (the frozen dead pool) | 141                |
| `diamond_transactions`           | 141                |
| `notifications.actor_id`         | 45                 |

No club ownership, no home games, no home groups, no `time_bank`, no `live_pins`.
None of these accounts ever played a hand or held a seat. The only constraint that
would have blocked the delete was `notifications.actor_id` (NO ACTION); those 45
rows were removed in the same transaction.

`profiles_id_fkey` references `auth.users` ON DELETE CASCADE, so the delete was
issued against `auth.users` and cascaded outward.

## Diamond supply removed

**1,259,900 diamonds** left circulation with these accounts. The bulk is the
`orb1_test_user_*` load rigs seeded at 100,000 each. This is phantom supply that
was never purchased and never earned, so its removal is a correction rather than
a loss, but it is recorded here because nothing else in the platform reconciles
`profiles.diamond_balance`.

## The 141

Format: `id | username | email | diamond_balance | created`

```
262b4a43-9749-4994-b6e5-b4b107ead280|finaltestpoker|finaltest2024@gmail.com|300|2026-01-24
cea20995-9f16-42fe-a3ee-7633f55a3ab2|testuser_jetski_01|testuser_jetski_01@example.com|300|2026-01-25
59f5df8c-9872-4f47-8cd0-aa493c33616a|test_persistence|test_persistence@smarter.poker|300|2026-01-25
f4567ffe-e2ab-4d95-994b-c3f345d79d3d|test_dev_agent|test_dev_agent@smarter.poker|300|2026-01-25
e6206d86-fa4f-46f5-a255-cd76110c31ef|johnnyd|johnnyd.test.march5@gmail.com|500|2026-03-05
ab593d67-5724-4255-afb8-abd6f62c1820|antiabusetest|antiabuse_e2e_1772758741697@gmail.com|500|2026-03-06
6df092dc-0fee-4120-9bc9-de4413c62b4f|antiabusetest744|antiabuse_e2e_1772758879922@gmail.com|500|2026-03-06
b5910828-17a2-46d6-bb8c-e6ff42f73b3d|e2e_tester_1772|e2e_tester_1772998386550@smarter.poker|500|2026-03-08
38503e9a-228f-4dd8-b927-b598d7fe23db|e2e_tester_1772475|e2e_tester_1772998422961@smarter.poker|500|2026-03-08
bebd825c-91ed-4e68-b312-3981b31f07e3|tester|tester@example.com|500|2026-03-09
dab09de7-abd8-42ea-858d-b362b4255367|god_0fe93a64-58|god_0fe93a64-58e8-4248-afff-bfab38813bdd@test.com|500|2026-03-10
214a0a86-0fb0-45e6-bde4-0e23c9babac2|god_e1e2350c-2c|god_e1e2350c-2cf7-4fc9-9120-03a4affcb4b3@test.com|500|2026-03-10
88c1ee3f-675e-4716-8f54-aee35b01a37a|god_fe2e49c8-e1|god_fe2e49c8-e1e7-4c73-81b4-42fa05b990cc@test.com|500|2026-03-10
0c444073-9a95-48bd-90ba-b79152cb8514|god_5f8a0e78-1b|god_5f8a0e78-1b56-43db-b73d-10ad1fd9b5e0@test.com|500|2026-03-10
7dddfcd0-ab32-4ed0-8e5e-c87bda0ab7aa|god_4433b652-94|god_4433b652-94e7-4227-909c-721da56a59ec@test.com|500|2026-03-10
04bc5968-52fb-4a06-ac27-b42befb8e83f|god_69b2c816-3c|god_69b2c816-3ce5-4eb2-be22-3fb14f9389f5@test.com|500|2026-03-10
db2c26b1-361b-4be8-a891-c215fe948fa3|god_5c7056af-a6|god_5c7056af-a69f-4ec9-8178-c2b1fc608116@test.com|500|2026-03-10
e0b83536-4091-4d71-a58c-aba635d6ce58|god_f4faf45a-cd|god_f4faf45a-cdb9-44a0-a0ff-c180153f2ac5@test.com|500|2026-03-10
25b0fa50-623b-44b1-ba24-713c5f67682e|god_dea6f7d9-bc|god_dea6f7d9-bcea-472b-980a-dfc498a2eee9@test.com|500|2026-03-10
0af2fbe0-da71-4fce-a92c-73070001c453|god_1b3239f0-83|god_1b3239f0-8333-419c-8caa-d8441cc10874@test.com|500|2026-03-10
619ffd61-629c-40fb-aede-d4a7721fb183|tester_6aefea7b|tester_6aefea7b-9622-4158-a052-3f27e52449c7@test.com|500|2026-03-10
086833b4-0670-4a07-b1a9-a0013e4c3dc0|tester_2aacb9ed|tester_2aacb9ed-394f-443d-bccd-ac1456d23aa3@test.com|500|2026-03-10
179cf7cb-bedf-4bfa-84d4-2177dd5b797f|tester_0de3ba07|tester_0de3ba07-1a8c-497d-89ec-fc527f0fa9c5@test.com|500|2026-03-10
c483121b-aab7-4211-8281-d3422a7fc6dd|tester_cf15da7e|tester_cf15da7e-eaac-422b-b4d4-9462d47adca3@test.com|500|2026-03-10
646748f4-ce4c-4123-b957-4a8148f37ee3|tester_acadefe1|tester_acadefe1-514a-44b1-b66f-d372785a9eb8@test.com|500|2026-03-10
51af3e3c-386a-44f1-a34e-d08034f0f262|tester_c7df2b0b|tester_c7df2b0b-f1bf-488b-8ee6-6a6241fa151a@test.com|500|2026-03-10
0835a7b4-8ae8-486b-aa44-e680affe4e4d|tester_4b3af066|tester_4b3af066-7dd2-488b-ace3-e60faa2ac320@test.com|500|2026-03-10
d2aff562-23b3-4d4b-a46e-fc33fb3a0597|tester_2358e044|tester_2358e044-2ffc-4aad-a12a-35004ef03e96@test.com|500|2026-03-10
bb338813-74b2-4e91-a4dd-84dabbe929b1|tester_a3d4539d|tester_a3d4539d-9abe-4ea7-b98e-27bdb23cf81a@test.com|500|2026-03-10
8311f22d-8492-4624-8717-64d41f89af36|tester_6122cfd9|tester_6122cfd9-6767-4a96-8c2f-d70e07aee025@test.com|500|2026-03-10
09a7ab2c-69dc-4081-b45a-c80ba26a2ce0|tester_67fff76f|tester_67fff76f-f491-416b-94b1-fb5b760f0bbd@test.com|500|2026-03-10
7fd44c33-5033-4e65-9c54-b99d8bd34a53|tester_bfac2646|tester_bfac2646-7089-409d-b092-c2b80c11e56e@test.com|500|2026-03-10
c81c113e-e2c8-43e6-ad73-1085f70b9844|tester_4cff0aca|tester_4cff0aca-5ffd-4aa7-99a4-62d3716b5e60@test.com|500|2026-03-10
2b8593e6-450d-41ab-990b-f8fb6c64607f|tester_d4789770|tester_d4789770-1e7b-4151-a048-b9eb5e4da5e3@test.com|500|2026-03-10
d4451add-6f16-4444-b131-7548280934b8|tester_2690cfc7|tester_2690cfc7-3038-4f44-8be6-5ab977d83cd1@test.com|500|2026-03-10
cb95da2f-bea8-49be-909d-df78162c1db7|tester_79aa6bad|tester_79aa6bad-d867-4eb2-9cd1-0fba86036dbe@test.com|500|2026-03-10
f732d7e0-63a0-4f8b-9b12-b9d9cdb53126|tester_5d6d8cf5|tester_5d6d8cf5-76d0-40e3-8089-3e134ac6195c@test.com|500|2026-03-10
abe8e1d5-ef94-42b2-82d8-fa87e20d3d6a|tester_c0953706|tester_c0953706-4183-460d-b487-e205ddc97328@test.com|500|2026-03-10
ab0697e8-63c2-497d-bcfd-930f86aa0b81|tester_1cdfc2e0|tester_1cdfc2e0-aa4d-4605-a375-f124793e54b2@test.com|500|2026-03-10
59ce70d1-515a-4e53-aac1-a11ec214eef1|tester_a1f56bf3|tester_a1f56bf3-85ee-4da4-8207-7c41fee8c305@test.com|500|2026-03-10
4cd99757-8e04-4021-a8be-59010f4290f3|tester_7c41d0ef|tester_7c41d0ef-c679-4a05-9ff3-bc22147f9034@test.com|500|2026-03-10
affc44ce-7761-48c6-8167-f1286ce5bf4e|tester_db69aa5c|tester_db69aa5c-eb48-42fa-a0fc-7adc32d2e3b5@test.com|500|2026-03-10
e8e4d9ff-8996-40e8-9f69-3392eb0a0129|tester_92e11721|tester_92e11721-97d2-49f1-b53d-bf0e269b7e46@test.com|500|2026-03-10
cfbc2db8-ae7e-4b01-a414-a7f4d0f802a5|tester_435b2949|tester_435b2949-a9b1-4980-b8a7-12443bdddb36@test.com|500|2026-03-10
d91a85c2-9491-43bc-9e9c-608b783e51d4|tester_8f99972a|tester_8f99972a-f574-4e92-a940-d3ddab31d116@test.com|500|2026-03-10
f6d69036-e1ac-4072-8627-74b293fa76d7|tester_df50d17d|tester_df50d17d-6184-4b26-ac63-c77d6898aa2e@test.com|500|2026-03-10
a1ce2bb1-e629-4f6d-ab76-03d3c7be9ec7|tester_bb789ac0|tester_bb789ac0-d400-4d94-81bd-8530ed5925da@test.com|500|2026-03-10
240b3f8b-e45b-426b-afd1-1e3a21209007|tester_dd48aaa1|tester_dd48aaa1-071c-4651-9652-5c9b52ea1db7@test.com|500|2026-03-10
2b5840ef-9c02-44d4-8ba0-4515e73fe58f|tester_63b2b9b6|tester_63b2b9b6-51f4-43f3-b6bb-207110aa54d3@test.com|500|2026-03-10
36db7a2b-64a5-49ed-98c2-cf7420e6eb81|tester_d3a1ba1d|tester_d3a1ba1d-e3a8-44ec-864f-04a33f2db181@test.com|500|2026-03-10
8d3cfc5d-ee83-4e55-969d-39d39f9588d4|tester_71d7a222|tester_71d7a222-583a-485f-a9d6-b1ec15aa31e2@test.com|500|2026-03-10
b5e2ab4f-2830-46ce-a14d-069ab236ac08|tester_8e08a439|tester_8e08a439-e093-496e-b9ea-3e8a72f54221@test.com|500|2026-03-10
c9220735-42d7-4714-a796-be5b76a66d40|tester_26bdb3b0|tester_26bdb3b0-75f0-4aef-a1ab-de63b0f66970@test.com|500|2026-03-10
4e6dde01-df39-42eb-b9c0-1b4c8dd2aa5d|tester_79bcd2f5|tester_79bcd2f5-1628-40c3-b635-1a4aafb3db96@test.com|500|2026-03-10
def64a29-34ee-4114-baf1-ee96178566af|tester_20ffa445|tester_20ffa445-714f-4a35-aa57-49f1c8cfaeb8@test.com|500|2026-03-10
43259709-c5c8-487e-8746-d95ea275dcf3|tester_76d7f06d|tester_76d7f06d-c9ec-4007-8700-87f5420c8a1e@test.com|500|2026-03-10
11494c48-8c77-45e5-b926-a86c78296581|tester_a2ca7b11|tester_a2ca7b11-bf48-4afb-83ec-deb224469d82@test.com|500|2026-03-10
0b8c3875-3e87-4fcc-9c7b-279085261634|tester_d9ff6e6b|tester_d9ff6e6b-bf42-4c47-bad0-03f8f743c36f@test.com|500|2026-03-10
860a5a2a-944d-4ddb-a31d-521b1d01a8c9|tester_7d4d3a0f|tester_7d4d3a0f-7597-46c3-93e0-c551384a4e37@test.com|500|2026-03-10
9ff012e4-3a78-4713-b6f0-d050858fb692|tester_6e370f88|tester_6e370f88-71c4-4567-bc1b-b96c804e07da@test.com|500|2026-03-10
b4a1f747-b418-4c1b-b161-058b4c1988d1|tester_24c426df|tester_24c426df-cdbe-4fa2-8885-4b5256df32a0@test.com|500|2026-03-10
54c4f2aa-a6ec-4587-89cc-b5b5a44124c1|tester_6b513f8c|tester_6b513f8c-da39-404d-89be-a47d21072c23@test.com|500|2026-03-10
cfc6ac56-0ecb-4c8f-aeb4-32e7bb36ae57|tester_098586b5|tester_098586b5-828a-47cf-8bac-ddaab1ce6c56@test.com|500|2026-03-10
8609de80-8a95-4177-9b1a-1c448fc56a3e|tester_f4ce7851|tester_f4ce7851-98fc-45e3-a88c-a3436c332cb4@test.com|500|2026-03-10
e83a63e7-2f0f-4c2d-b812-ca5e6deeec75|tester_4ec2fe94|tester_4ec2fe94-0baa-4990-bb71-20e01de839f0@test.com|500|2026-03-10
bd4e4dd4-7ea5-4f78-88a1-47f359366ac0|tester_a93fcf60|tester_a93fcf60-74ab-450e-881d-60c13cb455cf@test.com|500|2026-03-10
32d756b7-2caf-44e0-9d1c-8f12fe209a29|tester_f0522510|tester_f0522510-1f34-4a64-ad12-77ec7523e93c@test.com|500|2026-03-10
a30caa3e-ceac-4dcc-ad62-6533ef31b3d9|tester_bfdd2706|tester_bfdd2706-e9be-42f6-a9b6-304ae426c344@test.com|500|2026-03-10
b4412dee-1c57-4af3-87b7-b56c7c58e21e|tester_4f5b9eec|tester_4f5b9eec-ec13-4748-ad62-33abd16fca6c@test.com|500|2026-03-10
c6003bd8-178d-4e96-9ff2-85b735e0c1a4|tester_25877999|tester_25877999-3798-4062-a626-d1f489294a1c@test.com|500|2026-03-10
dd780065-c287-4e7b-917f-d5427fc33558|tester_71d296ce|tester_71d296ce-5904-4494-a0d5-f860637a67f2@test.com|500|2026-03-10
1c839ce2-383e-41a6-b7b3-a144a909de94|tester_803f52b2|tester_803f52b2-bbcf-49ba-bdde-7bf2de2119a1@test.com|500|2026-03-10
088544ad-0564-43e9-af75-be7873188948|tester_63c28ab4|tester_63c28ab4-6214-4fd1-aeb7-55b538b56e3c@test.com|500|2026-03-10
90053251-d014-4cc9-86eb-9daf7ce1905f|tester_b398ea84|tester_b398ea84-0fbf-4481-9116-4b07a340a6b2@test.com|500|2026-03-10
542df442-9d74-407f-ad76-a2f96374f8f2|tester_55df846a|tester_55df846a-9edb-4b5a-9da9-d04dfbcf6e90@test.com|500|2026-03-10
627540ef-7b19-4ac3-b88d-d53c2582418f|tester_ed978c46|tester_ed978c46-852c-4aeb-b858-ef39679076c6@test.com|500|2026-03-10
8dc1e9f2-1637-4f7c-9aae-c1ccb72c0f9c|tester_c3647f6f|tester_c3647f6f-accc-4e3f-8063-0e0c3191431b@test.com|500|2026-03-10
5f24cdc8-dc6c-45b2-bdee-a3271d52ebd0|tester_0c558972|tester_0c558972-2161-4f2b-95a0-b632aa5b72d8@test.com|500|2026-03-10
33a8ce90-0c9c-47a3-b504-14e85df71eac|tester_ff7655a6|tester_ff7655a6-34f9-4c77-837d-f6caa18b226d@test.com|500|2026-03-10
2e7d9b7c-6af6-46d4-b38d-52b1276033aa|tester_7333af13|tester_7333af13-50b8-4a14-8362-0c81479348f6@test.com|500|2026-03-10
eb57dd1b-019d-4549-9819-d2eaef5c77e1|tester_60e13a24|tester_60e13a24-efec-412f-9adc-eb516a699864@test.com|500|2026-03-10
9747968e-9398-4f8d-86a1-b8306bf5cf0e|tester_25ab9940|tester_25ab9940-fe95-46d1-a0d9-2cb0fe120d13@test.com|500|2026-03-10
07f40ebf-3fd5-42fd-ad0b-b7223d193a7c|tester_4b45af68|tester_4b45af68-b236-43f5-9eba-53e93499f891@test.com|500|2026-03-10
0af2d25d-af1f-49f0-903b-a440e0574498|tester_c1a420f2|tester_c1a420f2-edcb-45c8-80d0-adbe552dd1c1@test.com|500|2026-03-10
15c757f9-9ae3-4361-9af2-5004bb75902e|tester_384175d2|tester_384175d2-a0e7-43ce-b08f-559af12ee1e3@test.com|500|2026-03-10
1d216346-a391-488d-af7b-47fc54815366|tester_daa8b903|tester_daa8b903-e3d9-4cf2-aea0-348cd1bf18bf@test.com|500|2026-03-10
b1d08001-cb34-4ca3-b50f-c30d2b196030|tester_c77889c6|tester_c77889c6-ad20-4d60-a16c-22455bceccac@test.com|500|2026-03-10
86965a3a-ba0b-489c-a258-a8844b987b34|tester_b91f4371|tester_b91f4371-01e1-4041-8c94-6925f686e7d1@test.com|500|2026-03-10
4e7f7e7a-a2a9-4fa5-9169-e7ee719d7d54|tester_87594ab7|tester_87594ab7-1b39-4f59-b40f-2121d0c6a405@test.com|500|2026-03-10
feaef555-9d66-4a59-b72c-4f4adb5caaf6|tester_19d27d0b|tester_19d27d0b-37cb-475e-b0be-d781c3d5433c@test.com|500|2026-03-10
b4545587-38c7-4685-99bf-7f5bb6920315|tester_1088e4bf|tester_1088e4bf-c6ec-4bc3-a845-671bb3d77c80@test.com|500|2026-03-10
7850f9a6-a053-438b-85dc-4d531d6a8c1f|tester_675e0d5f|tester_675e0d5f-ade6-48b5-a2f9-7979482bbb8f@test.com|500|2026-03-10
007ab75d-c41b-4877-8fec-7584a49cd27b|tester_99b44856|tester_99b44856-7d00-4117-98f0-ddd509f2d3e1@test.com|500|2026-03-10
0b87efb2-5370-4353-9bbb-05f951997e6b|tester_afb42922|tester_afb42922-fc8a-4e19-a0c5-c5bcc7f299a8@test.com|500|2026-03-10
a5292240-bf3b-407c-9a21-a496d07a9d95|tester_272a4880|tester_272a4880-a8b7-4f59-af53-b4ec6fa43d76@test.com|500|2026-03-10
317dce85-2378-4a22-9d78-3d017033e2cf|tester_defcfe4c|tester_defcfe4c-d847-4c8a-ad3f-4a960f3cad17@test.com|500|2026-03-10
077d2bb4-55ce-467b-99e4-0190fac54a24|tester_0b415c0b|tester_0b415c0b-63f2-440f-a4df-10b6de2781b8@test.com|500|2026-03-10
95d66b16-9e5d-4da6-83aa-b07de4a826ca|tester_839d2223|tester_839d2223-d9f0-4fd9-a5e2-b0cea091fcd3@test.com|500|2026-03-10
9c69e215-8f56-45d6-b1f5-91fe2d408d7b|tester_62fb94ff|tester_62fb94ff-ccee-41ab-be0b-6fa32560e5f1@test.com|500|2026-03-10
551cde26-1b6e-4843-89f8-105586af259d|tester_19ef685d|tester_19ef685d-32c9-48c9-8c1e-2ce8883173d3@test.com|500|2026-03-10
0ad6a1c0-3759-4dd2-9c81-7946a42939f3|tester_832baf27|tester_832baf27-1b9c-414e-ad6b-24dd58dff01e@test.com|500|2026-03-10
e9df6582-ce51-481a-a0f3-53c34dc815b2|tester_440c1999|tester_440c1999-16a9-4f23-aef4-fb466821d3f1@test.com|500|2026-03-10
74ab6308-7a1a-4529-a90f-2542d2aad3a1|tester_2c71b43e|tester_2c71b43e-9af6-481f-b382-6838bcc2aa62@test.com|500|2026-03-10
13216935-f62c-43a7-aa15-412b41ad8c94|tester_45a5e989|tester_45a5e989-256e-4818-9b68-745dbe04fda6@test.com|500|2026-03-10
12671949-465b-4deb-82f3-9edf0f1b2d77|tester_9c68cdae|tester_9c68cdae-dcdc-40bf-b69e-a11059ce80e0@test.com|500|2026-03-10
b7b506c6-8b8f-47e5-b1aa-4ecfa66bde5c|tester_15c8cfeb|tester_15c8cfeb-5937-4ddd-b143-3c6397d903eb@test.com|500|2026-03-10
1b92c3d8-20b5-478d-8c11-a364e833e7ba|tester_9f27a34c|tester_9f27a34c-0403-4ee7-919c-c46f9915973d@test.com|500|2026-03-10
0a3af207-f5f2-48bc-82f9-fe359ad04947|tester_c9944341|tester_c9944341-5096-4143-8295-207c47cb3274@test.com|500|2026-03-10
88cc418b-81f2-4a03-8e80-0313e37bd750|tester_d0defb0c|tester_d0defb0c-5626-4770-9e6d-f579cd903279@test.com|500|2026-03-10
390362f7-da7b-42ff-bd77-03773db9c0f3|tester_77e2161f|tester_77e2161f-0f4f-4638-a7b8-ff8c6b280b25@test.com|500|2026-03-10
7a0c6789-c860-4229-abd9-14ce8f280af1|tester_7468f403|tester_7468f403-0da0-4763-8827-1b7693ccdecf@test.com|500|2026-03-10
282ec8da-3712-4362-8722-bf7f009e98e4|tester_bf54b5b8|tester_bf54b5b8-35ca-405e-b129-cf93ee84a118@test.com|500|2026-03-10
6b94b7cb-5246-45bb-9b55-1246ad6ba730|tester_1c8a402e|tester_1c8a402e-72b2-4199-9c77-96e040f3b72e@test.com|500|2026-03-10
ebc9ed0f-a1b6-49a2-a50c-eb26989fd829|tester_963bd290|tester_963bd290-eb67-4dcf-a355-0eecd12e6a31@test.com|500|2026-03-10
748fdbba-dc31-4996-a00a-10fed4c31a3f|tester_841bbf24|tester_841bbf24-410d-4f36-9def-2544fbb49164@test.com|500|2026-03-10
8e46c605-6669-428d-8b6b-2803d4cc37b4|tester_6399c8cf|tester_6399c8cf-e9cf-4e24-b45e-5006fdd9cf78@test.com|500|2026-03-10
7d909f76-87c0-4794-953f-939d358cea91|tester_e82805db|tester_e82805db-afe0-4412-b86f-acbc3b5f70f5@test.com|500|2026-03-10
199fa2da-c4c9-4cd1-9cca-d8ed17814410|tester_12d910e6|tester_12d910e6-94e8-4b3c-9587-a8c880b50dea@test.com|500|2026-03-10
05d15347-ca49-4b5d-8cd8-1c053c8fb5ed|tester_6969dabf|tester_6969dabf-c6a5-45d5-b474-b522bfd7fa59@test.com|500|2026-03-10
f1fb28f9-c659-4392-9059-fbc02d6ba8f9|tester_f1ec652c|tester_f1ec652c-3097-47a2-934c-87377033cc23@test.com|500|2026-03-10
0a85f382-1aef-4585-bfb8-db9a72a113b6|orb4test_177316|orb4test_1773161002243@example.com|500|2026-03-10
9dd83ac8-5360-4c47-9238-248bac442454|orb4test_177316365|orb4test_1773161024313@example.com|500|2026-03-10
c5afff8d-eaa3-4dea-ad5a-374af2cca00f|orb4lead_1773161065315|orb4lead_1773161061070@example.com|500|2026-03-10
110e3141-884b-4fc2-ab65-248bbf97475c|orb4lead_1773161257847|orb4lead_1773161257197@example.com|500|2026-03-10
eb5d75ff-8ba2-4fae-b41d-f5a0602d2d60|orb4lead_1773161305058|orb4lead_1773161301728@example.com|500|2026-03-10
3a3ba354-7295-4f31-9a0c-e21f33c7452e|dbg_1773161346678|debug_1773161343085@example.com|500|2026-03-10
56556834-8b5b-4fd6-82ff-93ed2b13a59d|dbg_1773161368337|debug_1773161364359@example.com|500|2026-03-10
191507bf-0070-4349-a299-9402c9ef21c2|verifier|verifier@test.com|500|2026-03-10
21374135-2271-4d89-b3b2-ab2bba108166|jetski_tester|jetski_tester@example.com|500|2026-03-10
ad7dff29-3041-4705-b036-dc7653d64ce8|orb1_test_user_226|orb1_test_user_960ccf56-f60f-473e-ad79-f4a07bedba71@smarter.poker|100000|2026-03-10
e31c1413-bc5f-4e6b-93a4-523a7877b9a9|orb1_test_user_921|orb1_test_user_7c84cfc5-3283-46b4-8723-eb4cb5634b32@smarter.poker|100000|2026-03-10
05c939a7-9f7f-4a18-a6c8-4ec42b6e8aa3|orb1_test_user_845|orb1_test_user_0476bbd4-dd6d-4d04-8497-8feb3dfa60b0@smarter.poker|100000|2026-03-10
25705fe7-589f-4ec9-b8cb-7e7503c0e075|orb1_test_user_535|orb1_test_user_54bb849b-18f1-42ba-9859-0ac5da11dde2@smarter.poker|100000|2026-03-10
d0c8d796-73e5-49cf-8daf-a4c004496b9c|orb1_test_user_608|orb1_test_user_fd76bcc3-3120-4083-8504-b522522af8cc@smarter.poker|100000|2026-03-10
1fd04d92-2417-49ea-99f5-9fed37c0acb4|orb1_test_user_158|orb1_test_user_cefef42a-c7b6-4d4e-93fa-c09d6fabfa57@smarter.poker|100000|2026-03-10
7af0df48-8677-4ca3-abb8-5dda21bfeee0|orb1_test_user_970|orb1_test_user_640470aa-d7b4-4cd7-abc9-41d668c10ca8@smarter.poker|100000|2026-03-10
10ac2444-f71c-4709-8d3e-a52a8a079d7d|orb1_test_user_399|orb1_test_user_11a752e6-acc1-4cc1-8a5e-f7464625eaaf@smarter.poker|100000|2026-03-10
f7bdddf8-17da-46c3-8733-af5cde7e8670|orb1_test_user_717|orb1_test_user_4fe5a684-f5b6-433b-bf5c-4a2b83096193@smarter.poker|100000|2026-03-10
e93acde2-838a-4a6e-8cd3-2bfe3ac187b3|orb1_test_user_75|orb1_test_user_b49ada93-d52f-4b56-bd58-0b477853577f@smarter.poker|100000|2026-03-10
50079f69-cd6b-45e8-8536-759c394e3589|orb1_test_user_719|orb1_test_user_75edb8ce-ddc6-4595-881d-33766e38934d@smarter.poker|98100|2026-03-10
032870be-ca1a-46f6-8df1-6819550ef61f|orb1_test_user_609|orb1_test_user_8b80f18e-5835-4704-8f68-58ec63299391@smarter.poker|98100|2026-03-10
```
