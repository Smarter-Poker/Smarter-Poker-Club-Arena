/**
 * Four exact-image first-install checkpoint profiles. This function has no module-scoped
 * dependencies: the publisher serializes it for Runtime.callFunctionOn, with
 * `this` bound to the discovered, already-running GameServer. It never creates
 * a server, opens an inspector, changes a pause/readiness flag, or retries a write.
 *
 * The trusted transport supplies the actual queryObjects array and already-loaded
 * module namespaces by objectId, not JSON copies or caller-provided credentials:
 * gameServer, base, maintenance, freezeState, releaseIdentity, tableLease,
 * client, dataActorContext, fs (node:fs), crypto (node:crypto). Loading/identity verification belongs
 * to that transport; the checks below additionally pin the three critical files.
 *
 * The 2f4 profile preserves its old untracked accounting semantics. The 758/a0 profiles
 * additionally requires its native debit registry already drained and its exact
 * checkpoint generation unchanged. The 8825 profile requires immutable original disposition and continuing custody
 * before exact registry retirement; none may settle a hand or approve restart.
 *
 * A disconnected/expired caller must retain an UNKNOWN operation, never retry it.
 * Started native writes are joined even after refusal; an RPC timeout remains an
 * ambiguous remote outcome. The existing publisher must freshly verify its native
 * certificate and >=245000ms reserve before stopping the process: the transaction
 * admits the checkpoint only while >=285000ms remain (its entry threshold), and
 * the whole 40 s the checkpoint then pays - ~15 s of entry (countdown detection,
 * the rollback proof, the helper preamble, the intent write and this module's
 * own boot, measured on run 35615604946) plus the publisher's bounded work
 * (workBudgetMs 20000 + cleanupBudgetMs 5000) - is paid out of the
 * candidate-proof budget, so 285 - 40 = 245 seconds is the exact figure
 * engine-release-transaction.sh accepts on the certificate it reads after a
 * legacy checkpoint (LEGACY_MIN_BREAK_REMAINING_MS). The 135-second rollback
 * reserve inside it is untouched. Success below is a checked instant, not a new
 * lock, a freeze extension, or a substitute certificate.
 */
export async function legacyEngineCheckpointGuard(options, discoveredServers, modules) {
  const release = options?.expectedReleaseSha;
  const retained8825 = release === '8825af51817f379c4261658ca29ecc9d8d81932d';
  const trackedAccounting =
    retained8825 ||
    release === '758610f3f844406bbbaee2f5100ced36d84fb943' ||
    release === 'a0ab287d902879280f0c915e44f5222c5db4d7df';
  // Fixed historical-loss disposition. It never asserts a native old bank.
  const historicalBankLoss = {"5a387a75-754a-416e-8fee-b85b15fc2702":{"kind":"historical_loss_normal_session_v1","receipt_id":"7d0f56e9-10ce-4c2f-b337-101b75924257","generation":"66291622-e7d1-4816-8c33-26ff1f092446","bank_witness_sha256":"31d0faaf9c8513f306160f0b7729d6e19dd8284677506d926805dbf9cb801af3","occupants":[{"table_id":"09f5e9eb-df66-4e55-a3c8-4385d27631e2","seat_id":"5cff5b9c-d48d-4391-8ec9-7cae469f57fe","occupancy_id":"164f4293-d57e-42c6-bbad-242f3d11e1cd","joined_at":"2026-09-17T17:06:16.817557+00:00","user_id":"046718c5-474f-4108-a15c-c3a1ce1f8d61","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"2c621856-e728-4e8b-bf08-4c56746a8649","seat_id":"df3e8f01-27ab-4973-bb90-792f82fac562","occupancy_id":"093709bf-995f-4848-bdda-da4f254a0cc9","joined_at":"2026-09-18T22:09:41.227524+00:00","user_id":"23e84589-611a-44ea-99e1-c51ae7ada6c5","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"2c621856-e728-4e8b-bf08-4c56746a8649","seat_id":"f6564dc7-d0ec-46f9-be3d-0ededac28fe3","occupancy_id":"f959c4dc-7b3d-4135-b160-c2fb11014196","joined_at":"2026-09-17T17:06:50.374103+00:00","user_id":"c1b575fb-3efd-43b6-b314-353e1d300aaa","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"49a444ac-553a-4f44-a36f-92781d10a646","seat_id":"7bbe071c-6253-4d65-bb87-8ce8103b1ce0","occupancy_id":"358500d2-527c-4026-81d4-fc8c908b9272","joined_at":"2026-09-17T17:07:48.373927+00:00","user_id":"a23ca5c9-b748-482f-9b59-9db35f7aa996","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"623b526d-0901-4c59-aec5-f8e459af7a6c","seat_id":"96e5f8fa-c883-4107-b469-4d89eb050eb0","occupancy_id":"d767fa91-e33b-446f-8867-30eaab0c2990","joined_at":"2026-09-17T17:08:04.809856+00:00","user_id":"00000000-0000-0000-0000-000000000038","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"6d8512e3-899d-442b-8d6c-7c57a5f4a1f1","seat_id":"933d6d7b-7d2e-455b-84f5-59432760ed9b","occupancy_id":"daf13850-0e47-4dfd-adc0-da5ac09f12dc","joined_at":"2026-09-17T17:07:31.133198+00:00","user_id":"302ba66b-3b1e-4747-9458-84695c70f396","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"815d35dd-a6d5-4469-b0aa-e386cc2145b9","seat_id":"1be3101b-5c33-4561-b64e-138d80609519","occupancy_id":"31c012fd-4f6e-4386-a62a-e44e1ad878a7","joined_at":"2026-09-17T21:38:20.734335+00:00","user_id":"c82e74af-4101-49b0-bd0f-93755f7bb13b","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"9bf11d84-684d-4069-916c-c7b5bb397d21","seat_id":"f2169a73-3148-4f14-b438-4fe6e5b40a0c","occupancy_id":"76c77980-c9b3-41ad-9200-896435d29e5c","joined_at":"2026-09-17T23:26:34.171939+00:00","user_id":"92ecbaed-bdec-49ae-96db-90e3d61a8f7b","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"dbd8b7ea-1a99-494f-b564-f86d412dc764","seat_id":"a87d1719-c2e1-4142-98e9-0b246ed249c0","occupancy_id":"c322a02b-5d56-4c0a-adab-8c00cda69381","joined_at":"2026-09-18T22:08:29.04283+00:00","user_id":"00000000-0000-0000-0000-000000000023","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"dbd8b7ea-1a99-494f-b564-f86d412dc764","seat_id":"c8296047-8c8b-458b-8695-e3990e920edb","occupancy_id":"0ebe3f87-4988-45b6-a5a4-b026326bb608","joined_at":"2026-09-18T22:06:46.596949+00:00","user_id":"38563ca3-66a9-40bb-8053-7a698887ec93","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"fcbbd2ea-6fc2-47df-8b61-b9997fcd7b16","seat_id":"4276abea-759f-48e6-ac59-c8a41e8d78b7","occupancy_id":"a94b8085-95f2-4e11-8f62-18d95ba47cb2","joined_at":"2026-09-18T22:10:08.554647+00:00","user_id":"c7a783ee-ac19-4a86-8e26-422666281805","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"fcbbd2ea-6fc2-47df-8b61-b9997fcd7b16","seat_id":"e8ef0440-81c7-4d6d-8c25-d9e1951456c1","occupancy_id":"78e9cbed-1128-439e-8336-349b19237c1a","joined_at":"2026-09-18T19:34:43.230547+00:00","user_id":"cb50fee0-a87b-4ac8-a6fe-8e665c5ddd8c","last_durable_seconds":40,"last_durable_uses":2}],"pending_arrivals":[{"kind":"pending_arrival_historical_loss_v1","table_id":"66b1cb1d-5056-41c1-a951-1bd078f8276f","lifecycle":283892,"seat_id":"093766ff-7108-4a69-a36f-189039af1a93","user_id":"6688345d-e7be-49bd-a318-4ee1e6b10253","occupancy_id":"f45e6d45-f041-4318-bd78-e5e066a77e17","joined_at":"2026-09-17T17:07:20.624929+00:00","seat_number":4,"stack":45000,"break_id":"3ebe59ce-4a7c-4290-960f-2843d7aebd71","origin_generation":"14e79c70-5590-47a4-bb9e-928bb8bd123a","request_id":"48b9a0f7-e40e-4163-845e-1a5244a2dac2","predecessor":"04a81643-7124-41e9-9a76-6111e627c288","amendment_id":"770b2444-2b8d-4f66-8138-d76adeed833f","destination_table_id":"09f5e9eb-df66-4e55-a3c8-4385d27631e2","destination_seat_number":2,"atomic_hand_id":"e18787c7-10a9-4435-85f3-31eaf95526d0","hand_number":12114088,"last_durable_seconds":40,"last_durable_uses":2,"payload_hash":"0af5bc2c83acb25b7c36054b30f6bd0a9af3db6c6bbbc8da8f45a415c29f430b","post_commit_request_hash":"b297208a812da14e5791a8fc5a45ee34b7235fd7acf1fb1e9366bbb3f1d1ebf8","post_commit_payload_hash":"8469adc20e2069d06dde4f35624461f88aa829cde49773ab8ee58791c94329ba","stack_hand_id":"911ceac9-72ab-68bb-405a-82f0e523fc1a","settlement_id":"8b4e4676-e9b2-44c1-8c35-8aa87be96308"}]},"615783bf-15e3-40b7-9368-75f21b6ac53b":{"kind":"historical_loss_normal_session_v1","receipt_id":"16268739-c7c3-4d38-8a8f-e8f08ac0591b","generation":"b3d06bad-c464-4be8-9e1b-66f7191375ff","bank_witness_sha256":"31d0faaf9c8513f306160f0b7729d6e19dd8284677506d926805dbf9cb801af3","occupants":[{"table_id":"383aa2c7-79f1-4937-9d7e-8c49126fce8b","seat_id":"19e141a8-bbc4-4864-a1e7-d5e46a66723c","occupancy_id":"61f4d574-eed6-4487-a4c8-a771ca326eb2","joined_at":"2026-09-17T22:06:23.33465+00:00","user_id":"46887b99-8cd6-45db-861c-ad24232efbfe","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"5973d7f6-5a52-4d78-aa92-cba86e19d4ea","seat_id":"e52388d6-d007-4e31-bafe-aefbe3bf3e40","occupancy_id":"f7056064-b637-47a1-8386-1da512a7d1f0","joined_at":"2026-09-17T22:06:22.513736+00:00","user_id":"374d0e7a-aef5-4d09-a2f2-5d4a18568d97","last_durable_seconds":20,"last_durable_uses":1},{"table_id":"737b1a84-da46-459c-b0e3-bba5b23171c0","seat_id":"0180cd98-024b-4406-8529-2ef52fc3c217","occupancy_id":"a08137de-c7b2-4268-b3ca-7f1720bca0a5","joined_at":"2026-09-17T22:06:36.220363+00:00","user_id":"1d81eaa9-42bc-4815-9616-01ad6e6d5800","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"9e18dc43-a81a-4a4f-a360-4f624c60699b","seat_id":"4a597dfc-98a2-4503-9913-c10f9349aa33","occupancy_id":"0eba0337-1825-4969-95ca-ff2260319e5a","joined_at":"2026-09-17T22:06:38.780641+00:00","user_id":"3a94c68d-2dd2-40b0-afea-96a238b505f2","last_durable_seconds":20,"last_durable_uses":1},{"table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","seat_id":"0d1d3c90-5b3d-4f48-9b45-6e4881a4d359","occupancy_id":"a0f25a76-732c-42d5-ab0c-f96d404428dc","joined_at":"2026-09-18T19:48:57.356759+00:00","user_id":"44f1ff92-b5de-44c5-9f7b-319318ff2a74","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","seat_id":"fd4646b0-d531-424c-85ac-f34baae5ac90","occupancy_id":"9eab6eee-7abb-404a-8b22-2747896c3123","joined_at":"2026-09-18T22:12:31.939388+00:00","user_id":"ae0bc48d-f98c-4b25-a9fa-e3522f986173","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","seat_id":"a77f5c0e-36c2-4d5e-9078-32350e36652c","occupancy_id":"292af3a4-995f-4fc9-8852-55d340cdddbe","joined_at":"2026-09-18T22:12:19.599699+00:00","user_id":"c49b2414-97ff-461c-8c20-3c05fe09809b","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","seat_id":"17f5edbc-6f65-4a92-87d9-994096f38a3a","occupancy_id":"af606bd2-8d9d-4692-8e61-ed3b2f1b8bf1","joined_at":"2026-09-18T22:10:36.076555+00:00","user_id":"cb35cc6f-3150-48ce-b7dc-887b6aca8327","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"9f30d335-8262-4872-8926-3ddf1fefe75c","seat_id":"535d19b3-b732-4d32-b614-f0f4bca07965","occupancy_id":"f137a187-d1c6-41ec-bbe1-8518e702a5ca","joined_at":"2026-09-18T22:10:36.511105+00:00","user_id":"f8c8eb13-14a0-4478-8771-7d29e71036ca","last_durable_seconds":40,"last_durable_uses":2},{"table_id":"9fdd5393-6fd9-4497-85b2-f98b89cf168d","seat_id":"f24cd458-be8d-43a6-9375-926524072f5f","occupancy_id":"dcc84998-a924-4bd7-89f0-f9359caba8d1","joined_at":"2026-09-17T22:07:06.763072+00:00","user_id":"f740e628-9097-47cf-91fc-95bbee245792","last_durable_seconds":120,"last_durable_uses":6},{"table_id":"d6199e5e-7c40-4560-afd9-f1a135031097","seat_id":"afb40353-6310-4f3e-8275-754bc26439e5","occupancy_id":"14955bd2-a8e9-4425-8b15-cb9829f48d11","joined_at":"2026-09-17T22:07:07.255289+00:00","user_id":"fdf075f5-e450-4099-a043-691377b0ae64","last_durable_seconds":20,"last_durable_uses":1}],"pending_arrivals":[]}};
  const reserveMs = 245000;
  // Refusal ceilings, not truncation or latency promises. The observed fleet has
  // 1379 tables, so the ordinary PostgREST 1000-row cap cannot bound the fleet.
  const maxTables = 2000;
  const maxEntriesPerTable = 64;
  const concurrency = 32;
  const readPageSize = 100;
  // ONE definition of "a hand is in the air", shared with the release gate:
  // an INCOMPLETE `hand_state_snapshots` row WRITTEN TO in the last 120s.
  // Measured and derived in server/scripts/engine-release-inflight-hands.py
  // (PR #5003) - live hands cluster under 60s, corpses are hours to weeks old,
  // and the band between is empty. Do not invent a second predicate here: two
  // definitions of the same fact is how a gate ends up disagreeing with itself.
  const inflightWindowMs = 120000;
  // How long the successor still reads a parked row's PRESENCE back
  // (`loadPresenceFromPark`, `PARKED_PRESENCE_FRESH_MS` in
  // server/src/services/supabase/snapshots.ts). A row older than this is read
  // for its banks only, which is exactly what a stopped engine's own park
  // write would have left it with.
  const parkedPresenceFreshMs = 20 * 60000;
  const filePins = retained8825
    ? [
        [
          '/app/dist/GameServer.js',
          'd87313450daee6035b9ee4945b9ee382d83d71b2ae39f1326a7059fcaa505332',
        ],
        [
          '/app/dist/engine/ServerTableEngineBase.js',
          '182cc4a8f3e181154ff586d0dd62506df5eae89f845169e21e7fa39d5e30088b',
        ],
        [
          '/app/dist/engine/ServerTableEngineDealing.js',
          '9aff42c79e62ca520b19ad49f5169b346417dabc82c25734b4e40a14a7fb96d1',
        ],
        [
          '/app/dist/tournament/TournamentManager.js',
          'b559245800e9f9f69c15a775df3b94f5afe6db926cec7b604c3bc93751bf2e29',
        ],
        [
          '/app/dist/tournament/TournamentManagerBase.js',
          '1460070a5fce172faa90c81698d660876535943264b27f6fa9ce89ef0bf10957',
        ],
        [
          '/app/dist/tournament/TournamentManagerOwnership.js',
          '0a99e8862c97716ba4435cb477621840f3e48355a018b6457fb6a7f245380fa0',
        ],
        [
          '/app/dist/services/F06HandPermit.js',
          'b42c7b954e1ec804b8819996ffe2dc1f1f8e6a74034b84fb17c154f35d9dc956',
        ],
        [
          '/app/dist/maintenance/MaintenanceBreak.js',
          'bc61dfe53e3becd3c7bf5cbe72f08b830cc71f68e37c5f06b462dba5588410a6',
        ],
        [
          '/app/dist/maintenance/freezeState.js',
          'f8ad56caef98973d535949e14030334ab49b3edbd18a9f6bc711681a469abee8',
        ],
        [
          '/app/dist/services/supabase/client.js',
          'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
        ],
        [
          '/app/dist/services/supabase/dataActorContext.js',
          '07ff29c562d000690437b62c46c87a10adb1fc40beb54e82ad863632b7e18985',
        ],
        [
          '/app/dist/services/tableLease.js',
          '123fa3e6a1dbaa11263b42bb09359859eb55f6ed687020f0bbb0c523f72033ba',
        ],
        [
          '/app/dist/releaseIdentity.js',
          '3386b6a5740b7f6fa936b4e1f0727199b0d661e134dcb20424e602c1d3db8c89',
        ],
        [
          '/app/dist/services/TournamentRetirementCustody.js',
          '9545296b55652a6861069f5b5ad8d5388d6b2fb36073b67c6235e9c1b0925e1e',
        ],
      ]
    : trackedAccounting
      ? [
          [
            '/app/dist/GameServer.js',
            'f8a4e646348fbd0209b9afde24658660dca0837f7720e04b47d37cff4fa2bea7',
          ],
          [
            '/app/dist/engine/ServerTableEngineBase.js',
            'cc715650eca1b6cfbccadcef46a9f07f581549e75df6581cb8c32f3fbfffc0b3',
          ],
          [
            '/app/dist/services/supabase/client.js',
            'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
          ],
          [
            '/app/dist/engine/ServerTableEngineDealing.js',
            release === 'a0ab287d902879280f0c915e44f5222c5db4d7df'
              ? 'a15d068c8a43ab0c34a208abf4380815813cf71a703978e334ed5c78ef70788b'
              : '44a7c52ede31dd3a5600d6b648b0d34c9ecabc3e10f14a65830712b432dc62e9',
          ],
        ]
      : [
          [
            '/app/dist/GameServer.js',
            'bfcb47c498c34408dd95047e90535c7ddc1ecc5fef14e41e1063ec72a1aad119',
          ],
          [
            '/app/dist/engine/ServerTableEngineBase.js',
            'f5c8f4f814d7fd5649cea03698443c21c592e7db1ac6c1ac9fc756af5a72c407',
          ],
          [
            '/app/dist/services/supabase/client.js',
            'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad',
          ],
        ];
  let reason = null;
  let stage = 'preflight';
  let attemptedTables = 0;
  let custodyCommitAttempted = false;
  let completedCalls = 0;
  let verifiedTables = 0;
  /* ═══ AN OUTCOME THE CLIENT LOST STILL SAYS HOW FAR IT GOT (2026-09-24) ═══

     Run 36041108119 (the 17:55 break) is the measurement: the transport
     reported `inspector operation outcome unknown` with `checkpointInvoked:
     true` and nothing else. The guard's call outlived the publisher's 20000ms
     work budget, and because the summary travels only as the call's return
     value, the one fact that decides the next fix - which stage was running,
     how many tables it had written, for how long - reached nobody. That is
     10.86 rule 1: "I could not tell" has to say what it does know.

     Observability only. The guard keeps a small record of its own progress
     on the predecessor's global object, stamped at every stage change and
     every table it writes or verifies. The client reads it back with one
     `Runtime.evaluate` on the cleanup path it already walks, and only when
     the outcome is unknown. Nothing here is read by a decision, nothing here
     names a player, a bank or a row, and the predecessor is the process that
     is about to be replaced. */
  const progressStartedAt = Date.now();
  let progressNote = 'start';
  const progress = (note) => {
    try {
      if (typeof note === 'string') progressNote = note;
      globalThis.__legacyEngineCheckpointProgress = {
        schema: 'legacy-engine-checkpoint-progress/v1',
        startedAt: progressStartedAt,
        elapsedMs: Date.now() - progressStartedAt,
        stage,
        note: progressNote,
        attemptedTables,
        completedCalls,
        verifiedTables,
        reason,
      };
    } catch {
      // Progress is a courtesy to the reader, never a condition.
    }
  };
  progress('start');
  let bankCount = 0;
  let uninitializedSeats = 0;
  // Observability only: which tables were PROVED abandoned from rows, and how
  // many generations each carried. Never read by a decision.
  let abandonedBoundaries = null;
  // Observability only: how many 8825 cash engines were in the map at the
  // snapshot without ever having completed `start()` (never dealt, no seat, no
  // bank), and how many times the churn replaced or removed one while the
  // checkpoint ran. Never read by a decision.
  let skippedUnstarted = 0;
  // Observability only: how many residue players and disposed seats the rows
  // proved held nothing, on how many tables, and which stopped tournaments.
  // Never read by a decision.
  let bankDisposition = null;
  let unstartedReplacements = 0;
  let unstartedDepartures = 0;
  // Observability only: how many retained managers the rows proved this guard
  // had already sealed in an earlier run, so this run transferred nothing for
  // them. Never read by a decision.
  let sealedManagers = 0;
  // Observability only: what the seal lookup answered for each retained
  // manager (`sealed`, `none`, `other_generation`, `unanswered`, `malformed`).
  // Never read by a decision: a lookup that did not answer leaves the unsealed
  // path exactly as it was.
  let sealedLookup = null;
  const sealedLookups = [];
  // Observability only: which tables held an F06 permit that no process could
  // ever resolve, and the phase each permit was in when the rows proved the
  // felt quiet. Never read by a decision.
  let unresolvableCustody = null;
  // Observability only: which dead engines' park rows were PROVED from the
  // row they had read rather than written again, with what each row held.
  // Never read by a decision.
  let provedRows = null;
  const refuse = (code) => {
    if (reason === null) reason = code;
    progress('refused');
    throw new Error('legacy_checkpoint_refused');
  };
  const require = (condition, code) => {
    if (!condition) refuse(code);
  };
  // Observability only: it names which sub-condition refused, and never takes
  // part in a decision. It is written on a refusal path that is already
  // throwing, under a catch that discards any error, and is read only when the
  // emitted result object is assembled. No check, threshold or outcome moves.
  let refusalDetail = null;
  const noteRefusal = (detail) => {
    if (reason !== null || refusalDetail !== null) return;
    try {
      refusalDetail = detail();
    } catch {
      refusalDetail = null;
    }
  };
  // Observability only. `witness` evaluates the exact original sub-expressions
  // of one conjunction, in the exact original left-to-right order, and stops at
  // the first false one - so nothing extra is read on a path where the original
  // `&&` short-circuited, and no check, threshold or outcome moves. It refuses
  // with the exact original code, naming the sub-condition that refused.
  const witness = (code, parts, extra) => {
    for (const [failedCheck, evaluate] of parts) {
      if (evaluate()) continue;
      noteRefusal(() => ({ failedCheck, ...(extra === undefined ? {} : extra()) }));
      refuse(code);
    }
  };
  // A non-sensitive shape witness: booleans, numbers, sizes, type names and
  // short identifier-like strings. Any other string becomes its length only, so
  // no permit payload, card, credential or player identity can reach a log.
  const describe = (value) => {
    try {
      if (value === null) return 'null';
      if (value === undefined) return 'undefined';
      const kind = typeof value;
      if (kind === 'boolean' || kind === 'number') return String(value);
      if (kind === 'bigint' || kind === 'symbol' || kind === 'function') return kind;
      if (kind === 'string') return /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(value)
        ? value
        : `string(${value.length})`;
      if (Array.isArray(value)) return `Array(${value.length})`;
      if (value instanceof Map) return `Map(${value.size})`;
      if (value instanceof Set) return `Set(${value.size})`;
      if (value instanceof Promise) return 'Promise';
      return 'object';
    } catch {
      return 'unreadable';
    }
  };
  /* A database refusal names itself. Every `f06` function raises a bare
     upper-case token (`F06_MIXED_OLD_LEASE_CHANGED`), and PostgREST hands that
     token back as the error's `message` with the SQLSTATE beside it. Those are
     the two facts a refused release needs and neither one names a player, a
     bank or a row. Anything that is NOT such a token is reduced to its length
     by `describe`, so a message that carried a payload could not export it. */
  // A bare upper-case token, or one token naming one lower-case key after a
  // colon: `f06_retired_origin_transfer` raises
  // `F06_RETIRED_CANONICAL_CHANGED: registrations`, and the key is the whole
  // finding (run 36095932476 carried it as `string(44)`). Anything else is
  // still reduced to its length.
  const refusalToken = (value) =>
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}(: [a-z_]{1,32})?$/.test(value)
      ? value
      : describe(value);
  /* A SQLSTATE is five characters of `[0-9A-Z]` and nothing else - the SQL
     standard fixes both the length and the alphabet - so it can be carried
     whole and can carry nothing. `refusalToken` alone would not: half of them
     begin with a digit (`57014`, `42501`, `23505`) and would be reduced to
     their length, which is the one thing a SQLSTATE does not tell you.
     PostgREST's own codes (`PGRST202`) are identifier-shaped and fall through
     to the token rule; anything else falls through that to its length. */
  const sqlState = (value) =>
    typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value) ? value : refusalToken(value);
  const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const uuid = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const finiteNonnegative = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (record(value))
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(',')}}`;
    return JSON.stringify(value);
  };
  const detached = (value) => JSON.parse(JSON.stringify(value));
  const validBank = (bank) =>
    record(bank) &&
    uuid(bank.occupancyId) &&
    [
      'remainingSeconds',
      'usesRemaining',
      'initialSeconds',
      'baseSeconds',
      'dbConsumedSeconds',
    ].every((key) => finiteNonnegative(bank[key])) &&
    Number.isSafeInteger(bank.usesRemaining) &&
    bank.remainingSeconds <= bank.initialSeconds &&
    bank.baseSeconds <= bank.initialSeconds &&
    bank.dbConsumedSeconds <= bank.initialSeconds - bank.baseSeconds;
  // Observability only: WHICH tables `captureEngine` refused and under which
  // code, across the whole capture walk instead of the first table alone. One
  // refused release costs a maintenance break, and until now it named one
  // table, so a fleet with six separate shapes in it took six breaks to read.
  // It is written on a refusal path that is already throwing, through the same
  // `require` that refuses, and is read only when the emitted result object is
  // assembled. `reason` still holds the FIRST refusal, no check, threshold or
  // outcome moves, and the walk that fills it is followed immediately by the
  // same throw the first refusal raised, so nothing is captured, proved or
  // written after it.
  // Observability only: WHAT is inside the rejections the previous-work join
  // meets, whether it refuses on them or steps over them. Never read by a
  // decision.
  let nativeWorkMembers = null;
  let refusalCensus = null;
  const censusByCode = new Map();
  const censusTables = [];
  let censusRefusals = 0;
  const noteCensus = (tableId, code) => {
    try {
      censusRefusals++;
      censusByCode.set(code, (censusByCode.get(code) ?? 0) + 1);
      if (censusTables.length < maxTables && uuid(tableId)) censusTables.push(tableId.slice(0, 8));
      refusalCensus = `refusedTables=${censusRefusals} ${[...censusByCode]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([name, count]) => `${name}=${count}`)
        .join(' ')} tables=${censusTables.join('/')}`.slice(0, 512);
    } catch {
      // An unreadable census is never a decision. It keeps what it had.
    }
  };
  const result = (ok, remainingMs = null) => ({
    schema: 'legacy-engine-checkpoint/v1',
    ok,
    reason,
    stage,
    attemptedTables,
    completedCalls,
    verifiedTables,
    bankCount,
    uninitializedSeats,
    remainingMs,
    readyForRestart: ok,
    checkpointOutcome: ok
      ? 'verified_at_observation'
      : attemptedTables > 0 || custodyCommitAttempted
        ? 'unconfirmed'
        : 'not_started',
    paidAccountingQualification: trackedAccounting
      ? ok
        ? 'native_pending_registry_drained'
        : 'native_pending_registry_unqualified'
      : 'legacy_untracked',
    restartAuthorized: false,
    // Appended last so every pre-existing key keeps its exact name, value
    // and position. `reason` above is untouched for existing parsers.
    ...(abandonedBoundaries === null ? {} : { abandonedBoundaries }),
    ...(refusalDetail === null ? {} : refusalDetail),
    ...(retained8825
      ? { skippedUnstarted, unstartedReplacements, unstartedDepartures, sealedManagers }
      : {}),
    ...(bankDisposition === null ? {} : { bankDisposition }),
    ...(unresolvableCustody === null ? {} : { unresolvableCustody }),
    ...(nativeWorkMembers === null ? {} : { nativeWorkMembers }),
    ...(refusalCensus === null ? {} : { refusalCensus }),
    ...(provedRows === null ? {} : { provedRows }),
    ...(sealedLookup === null ? {} : { sealedLookup }),
  });

  try {
    require(record(options) && record(modules), 'invalid_arguments');
    require((trackedAccounting || release === '2f4e33560bcd23bfb5cc731f31816b2c2e2847e5') &&
      typeof options.expectedInstanceId === 'string' &&
      options.expectedInstanceId.length > 0 &&
      Number.isSafeInteger(options.expectedPid) &&
      options.expectedPid === process.pid, 'process_identity_mismatch');
    require(modules.releaseIdentity?.ENGINE_RELEASE_IDENTITY?.releaseSha === release &&
      modules.releaseIdentity.ENGINE_RELEASE_IDENTITY.version === release.slice(0, 8) &&
      modules.tableLease?.INSTANCE_ID === options.expectedInstanceId, 'release_identity_mismatch');
    require(Array.isArray(discoveredServers) &&
      discoveredServers.length === 1 &&
      discoveredServers[0] === this, 'server_not_unique');
    require(typeof modules.gameServer?.GameServer === 'function' &&
      Object.getPrototypeOf(this) ===
        modules.gameServer.GameServer.prototype, 'server_prototype_mismatch');
    require(typeof modules.base?.ServerTableEngineBase === 'function' &&
      typeof modules.maintenance?.MaintenanceBreak === 'function' &&
      typeof modules.freezeState?.isMaintenanceFrozen === 'function' &&
      typeof modules.dataActorContext?.currentTournamentDataAuthority === 'function' &&
      typeof modules.dataActorContext?.bindTournamentDataAuthority === 'function' &&
      typeof modules.client?.supabase?.from === 'function' &&
      typeof modules.fs?.readFileSync === 'function' &&
      typeof modules.fs?.statSync === 'function' &&
      typeof modules.crypto?.createHash === 'function', 'module_binding_invalid');
    const verifyFiles = () => {
      for (const [path, expected] of filePins) {
        const stat = modules.fs.statSync(path);
        require(stat.isFile() &&
          stat.size > 0 &&
          stat.size <= 2 * 1024 * 1024, 'compiled_source_mismatch');
        const bytes = modules.fs.readFileSync(path);
        require(bytes.length === stat.size &&
          modules.crypto.createHash('sha256').update(bytes).digest('hex') ===
            expected, 'compiled_source_mismatch');
      }
    };
    verifyFiles();

    const server = this;
    const tableMap = server.tableEngines;
    const maintenance = server.maintenanceBreak;
    const serverGeneration = server.lifecycleGeneration;
    require(tableMap instanceof Map && tableMap.size <= maxTables, 'fleet_bound_or_shape');
    require(Object.getPrototypeOf(maintenance) ===
      modules.maintenance.MaintenanceBreak.prototype, 'maintenance_prototype_mismatch');
    const maintenancePrototype = modules.maintenance.MaintenanceBreak.prototype;
    require(maintenance.remainingMs === maintenancePrototype.remainingMs &&
      maintenance.readyForRestart ===
        maintenancePrototype.readyForRestart, 'maintenance_method_mismatch');
    const maintenanceFence = {
      phase: maintenance.phase,
      announcedAt: maintenance.announcedAt,
      breakStartedAt: maintenance.breakStartedAt,
      breakEndsAt: maintenance.breakEndsAt,
      reason: maintenance.reason,
      ownershipToken: maintenance.ownershipToken,
      lifecycleGeneration: maintenance.lifecycleGeneration,
      resumeToken: maintenance.resumeToken,
    };
    const initialRemainingMs = maintenance.remainingMs();
    const beganMonotonicMs = performance.now();
    const entries = [...tableMap.entries()];
    const retiredOriginals = new Set();
    // Tables whose ONLY unfinished item is a terminal-boundary generation that
    // can never resolve in this process. They are NOT waved through here:
    // `physical()` is synchronous and may not read a row, so it DEFERS them,
    // and `proveAbandonedBoundaries` refuses unless the database says the felt
    // is quiet for each one, before any original is retired.
    const deferredAbandonedBoundaries = new Map();
    // Tables whose ONLY unfinished item is an F06 permit held by an engine that
    // is stopped and terminal - an engine that will never run again, so no
    // process can ever resolve that permit. Same discipline as the boundary
    // deferral above: `captureEngine` is synchronous and may not read a row, so
    // it DEFERS them, and `proveUnresolvableCustody` refuses unless the
    // database says the felt is quiet for each one, before anything is written.
    const deferredUnresolvableCustody = new Map();
    // The subset of the above that the rows actually answered for. A deferral
    // is not a proof, and only a proof may be read by the readiness decision.
    const provenUnresolvableCustody = new Set();
    const retainedManagers = [];
    let checkRetained = () => {};
    const engines = new Set();
    const tableIds = new Set();
    const captures = [];
    // 8825 cash engines observed at the snapshot before they ever completed
    // `start()`. They are not captured; `checkUnstarted` follows them instead.
    const unstartedTables = new Map();
    let checkUnstarted = () => {};
    const base = modules.base.ServerTableEngineBase.prototype;
    const checkMaintenance = () => {
      // This bridge originates at process scope. Existing tournament-engine
      // wrappers enter their own authority; never unwrap/rebind those methods or
      // inherit one tournament's actor for another table or the fleet readback.
      require(modules.dataActorContext.currentTournamentDataAuthority() ===
        null, 'unexpected_tournament_context');
      witness('server_changed', [
        ['server.running', () => server.running === true],
        ['server.teardownPromise', () => server.teardownPromise === null],
        ['server.lifecycleGeneration', () => server.lifecycleGeneration === serverGeneration],
        ['server.tableEngines', () => server.tableEngines === tableMap],
        ['server.maintenanceBreak', () => server.maintenanceBreak === maintenance],
      ]);
      require(discoveredServers.length === 1 &&
        discoveredServers[0] === server, 'server_not_unique');
      require(modules.freezeState.isMaintenanceFrozen() === true &&
        maintenance.phase === 'counting_down' &&
        maintenance.durableConfirmed === true &&
        maintenance.ending === false &&
        maintenance.acceptingLifecycleWork === true &&
        maintenance.releaseBoundaryOnly === false &&
        maintenance.recoveryReadPending === false &&
        maintenance.stopOperation === null, 'maintenance_not_durable_countdown');
      for (const [key, value] of Object.entries(maintenanceFence)) {
        require(maintenance[key] === value, 'maintenance_changed');
      }
      require(uuid(maintenance.ownershipToken) &&
        Number.isSafeInteger(maintenance.breakEndsAt) &&
        Number.isSafeInteger(maintenance.announcedAt) &&
        Number.isSafeInteger(maintenance.breakStartedAt), 'maintenance_shape');
      const durable = maintenance.lastDurableState;
      require(record(durable) &&
        ['phase', 'announcedAt', 'breakStartedAt', 'breakEndsAt', 'reason', 'ownershipToken'].every(
          (key) => durable[key] === maintenanceFence[key]
        ), 'maintenance_receipt_mismatch');
      const remaining = Math.min(
        maintenance.remainingMs(),
        initialRemainingMs - (performance.now() - beganMonotonicMs)
      );
      require(Number.isFinite(remaining) && remaining >= reserveMs, 'insufficient_reserve');
      // The whole fleet is NOT pinned here. The live 8825 engine re-admits and
      // kills a foreign cash table every ~5 s (it sits in `tableEngines` for
      // 0.6-4 s per cycle), so a whole-fleet size/identity witness refused
      // every checkpoint (`fleet_identity_changed`, `fleet.size`). A foreign
      // table's arrival or departure cannot touch the custody this checkpoint
      // retires. What IS pinned, by object identity, is every table the
      // checkpoint touches: each captured engine, each retained original
      // selected for retirement, and each original already retired - which
      // must stay gone from the global map. A pinned table that is replaced
      // or vanishes still refuses, naming the table and which way it moved.
      const pinnedTables = () => [
        ...captures.map(({ tableId, engine }) => [tableId, engine]),
        ...retainedManagers.flatMap((capture) =>
          capture.exactEngines.map(({ tableId, engine }) => [tableId, engine])
        ),
        ...[...retiredOriginals].map((id) => [id, null]),
      ];
      const pinnedIntact = ([id, engine]) =>
        retiredOriginals.has(id) ? !tableMap.has(id) : tableMap.get(id) === engine;
      const movedTable = () => {
        const found = pinnedTables().find((pinned) => !pinnedIntact(pinned));
        if (found === undefined) return 'none';
        return retiredOriginals.has(found[0])
          ? `retired_still_present:${found[0]}`
          : tableMap.has(found[0])
            ? `engine_replaced:${found[0]}`
            : `table_departed:${found[0]}`;
      };
      witness(
        'fleet_identity_changed',
        [
          [
            'fleet.retired',
            () => [...retiredOriginals].every((id) => !tableMap.has(id)),
          ],
          [
            'fleet.pinned',
            () => pinnedTables().every(pinnedIntact),
          ],
        ],
        () => ({
          observed: describe(tableMap.size),
          expected: `pinned:${pinnedTables().length}`,
          failedTable: movedTable(),
        })
      );
      checkRetained();
      checkUnstarted();
      return remaining;
    };
    checkMaintenance();

    // This exact predecessor has no native mixed-custody adoption method. The
    // bridge preserves its original objects and permits, and transfers their
    // complete custody before using the existing synchronous global identity CAS.
    // It never calls stop, releases a move ACK, or edits a readiness/permit flag.
    async function captureMixedOriginals() {
      const intent = options.custodyIntent;
      const selected = [
        '5a387a75-754a-416e-8fee-b85b15fc2702',
        '615783bf-15e3-40b7-9368-75f21b6ac53b',
      ];
      require(record(intent) &&
        intent.source === release &&
        intent.instance === options.expectedInstanceId &&
        intent.instance === '1-3846b8bb' &&
        intent.container === 'c63b254ee71b76aa26f4d1394d96189963774310244b046bc91186e219ca3f66' &&
        intent.startedAt === '2026-09-18T21:55:50.88305198Z' &&
        intent.hostPid === 1231816 &&
        /^[1-9][0-9]*(-[1-9][0-9]*)?$/.test(intent.runId) &&
        /^[0-9a-f]{40}$/.test(intent.controlSha) &&
        intent.retryAllowed === false &&
        Array.isArray(intent.custody) &&
        intent.custody.length === selected.length &&
        intent.custody.every(
          (c, index) =>
            record(c) &&
            c.tournament_id === selected[index] &&
            uuid(c.transfer_id) &&
            uuid(c.successor_generation)
        ) &&
        new Set(intent.custody.flatMap((c) => [c.transfer_id, c.successor_generation])).size ===
          4, 'mixed_intent_identity_invalid');
      require(typeof modules.manager?.TournamentManager === 'function' &&
        typeof modules.managerBase?.TournamentManagerBase === 'function' &&
        typeof modules.permit?.F06HandPermit === 'function' &&
        typeof modules.retirement?.TournamentRetirementCustody === 'function' &&
        typeof modules.client.supabase.rpc === 'function', 'mixed_modules_invalid');
      const managerMap = server.tournamentEngines;
      const retirement = server.tournamentRetirementCustody;
      const ownedTables = server.tournamentOwnedTables;
      const unregister = server.unregisterTournamentTableEngine;
      require(managerMap instanceof Map &&
        ownedTables instanceof Set &&
        retirement instanceof modules.retirement.TournamentRetirementCustody &&
        retirement.held instanceof Map &&
        retirement.pending instanceof Map &&
        retirement.active instanceof Set &&
        unregister ===
          modules.gameServer.GameServer.prototype
            .unregisterTournamentTableEngine, 'mixed_registry_shape');
      const retained = new Set();
      const boundMethods = (target, tournamentId, leaseGeneration, names) => {
        const symbols = Object.getOwnPropertySymbols(target).filter(
          (symbol) => symbol.description === 'smarter.tournament-data-authority'
        );
        require(symbols.length === 1, 'mixed_authority_invalid');
        const descriptor = Object.getOwnPropertyDescriptor(target, symbols[0]);
        const authority = descriptor?.value;
        require(descriptor?.configurable === false &&
          descriptor.enumerable === false &&
          descriptor.writable === false &&
          record(authority) &&
          Object.isFrozen(authority) &&
          Object.keys(authority).sort().join(',') === 'actor,leaseGeneration,tournamentId' &&
          authority.actor === 'tournament-manager' &&
          authority.tournamentId === tournamentId &&
          authority.leaseGeneration === leaseGeneration, 'mixed_authority_invalid');
        const wrapper = Function.prototype.toString.call(
          modules.dataActorContext.bindTournamentDataAuthority(
            authority,
            base.hasReleasedProcessOwnership
          )
        );
        require(names.every((name) => {
          const method = Object.getOwnPropertyDescriptor(target, name);
          return (
            method &&
            typeof method.value === 'function' &&
            Function.prototype.toString.call(method.value) === wrapper
          );
        }), 'mixed_native_method_mismatch');
        return names.map((name) => target[name]);
      };
      const sorted = (map) => {
        require(map instanceof Map && map.size <= maxTables, 'mixed_map_incomplete');
        return [...map].sort(([a], [b]) => String(a).localeCompare(String(b)));
      };
      const mapKeys = {
        durable: 'durableTournamentBreaks',
        pending_moves: 'pendingTournamentSeatMoveOutcomes',
        parks: 'pendingTournamentParkRequests',
        begins: 'pendingTournamentBreakBegins',
        amendments: 'pendingTournamentBreakAmendments',
        rejected_begins: 'rejectedTournamentBreakBegins',
        resolved_proposals: 'resolvedTournamentBreakProposals',
        custody_ids: 'pendingTournamentBreakCustodyIds',
        cleanup_kinds: 'pendingTournamentCleanupKinds',
      };
      const emptySets = [
        'lifecycleJobs',
        'tableEngineStartJobs',
        'tableEngineRunJobs',
        'eliminationSchedulerJobs',
        'lifecycleTimeouts',
        'lifecycleIntervals',
        'activeStoppedOriginalCustody',
      ];
      const engineSets = [
        'settlementInFlight',
        'tournamentMoveOperations',
        'readContinuationTasks',
        'terminalBoundaryPendingGenerations',
        'timeBankAccountingPending',
      ];
      const engineMaps = ['tournamentMoveOperationByOwner', 'entryHoldWriteChains'];
      const serialFields = ['presenceSave', 'seatBoundaryTail', 'teardownPromise'];
      // Inspect every supported engine-holding manager map, not a selected
      // diagnostic response. Unknown map shape refuses this separate source.
      const absentPendingSource = (tableId) => {
        require(!tableMap.has(tableId) && !ownedTables.has(tableId) &&
          !retirement.held.has(tableId) && !retirement.pending.has(tableId) &&
          !retirement.active.has(tableId), 'mixed_pending_source_present');
        for (const key of ['tableEngineStartPromises', 'directTableAdmissionOperations', 'directTableRecoveryTimers',
          'directTableAdmissionLeaseGenerations', 'directTablePendingLeaseReleases']) {
          require(server[key] instanceof Map && !server[key].has(tableId), 'mixed_pending_source_admission_unknown');
        }
        const managers = [];
        require(managerMap.size <= maxTables, 'mixed_pending_source_maps_unknown');
        require(server.tournamentDiagnosticRetirements instanceof Map, 'mixed_pending_source_maps_unknown');
        const owners = new Map([...managerMap].map(([id, manager]) => [manager, id]));
        for (const [id, retired] of server.tournamentDiagnosticRetirements) {
          require(retired instanceof Set && retired.size <= maxTables, 'mixed_pending_source_maps_unknown');
          for (const manager of retired) owners.set(manager, id);
        }
        const packetOwner = (packet) => {
          require(record(packet) && packet.manager instanceof modules.managerBase.TournamentManagerBase &&
            Array.isArray(packet.engines) && packet.engines.length <= maxTables, 'mixed_pending_source_maps_unknown');
          for (const pair of packet.engines) {
            require(Array.isArray(pair) && pair.length === 2 && pair[1] instanceof modules.base.ServerTableEngineBase,
              'mixed_pending_source_maps_unknown');
            require(pair[0] !== tableId && pair[1].tableId !== tableId, 'mixed_pending_source_present');
          }
          owners.set(packet.manager, packet.tournamentId);
        };
        require(server.drainedF06TournamentCustody instanceof Map && server.completedF06TournamentCustody instanceof Map &&
          server.drainedF06TournamentCustody.size <= maxTables && server.completedF06TournamentCustody.size <= maxTables,
          'mixed_pending_source_maps_unknown');
        for (const packet of server.drainedF06TournamentCustody.values()) packetOwner(packet);
        for (const packets of server.completedF06TournamentCustody.values()) {
          require(packets instanceof Set && packets.size <= maxTables, 'mixed_pending_source_maps_unknown');
          for (const packet of packets) packetOwner(packet.original);
        }
        require(owners.size <= maxTables, 'mixed_pending_source_maps_unknown');
        for (const [owner, tournamentId] of owners) {
          require(owner instanceof modules.managerBase.TournamentManagerBase &&
            uuid(owner.managerLifecycleDiagnostics?.instanceId), 'mixed_pending_source_maps_unknown');
          for (const key of ['tableEngines', 'stoppedDiagnosticOriginals', 'satelliteQualifierEngines', 'retainedTournamentBreakSources', 'pendingNoStartContinuations',
            'stoppedOriginalBreaks', 'tournamentBreakArrivalWakes']) {
            const map = owner[key];
            require(map instanceof Map && map.size <= maxTables, 'mixed_pending_source_maps_unknown');
            for (const [id, value] of map) {
              require(uuid(id), 'mixed_pending_source_maps_unknown');
              require(id !== tableId, 'mixed_pending_source_present');
              const checkEngine = (engine) => {
                require(engine instanceof modules.base.ServerTableEngineBase && uuid(engine.tableId), 'mixed_pending_source_maps_unknown');
                require(engine.tableId !== tableId, 'mixed_pending_source_present');
              };
              if (key === 'tournamentBreakArrivalWakes') {
                require(value instanceof Map && value.size <= maxTables, 'mixed_pending_source_maps_unknown');
                for (const [request, engine] of value) { require(uuid(request), 'mixed_pending_source_maps_unknown'); checkEngine(engine); }
              } else if (key === 'retainedTournamentBreakSources' || key === 'pendingNoStartContinuations') {
                require(record(value), 'mixed_pending_source_maps_unknown'); checkEngine(value.engine);
                if (key === 'pendingNoStartContinuations') require(record(value.binding) &&
                  value.binding.tableId === value.engine.tableId, 'mixed_pending_source_maps_unknown');
              } else checkEngine(value);
            }
          }
          require(owner.drainedF06Originals === null || Array.isArray(owner.drainedF06Originals), 'mixed_pending_source_maps_unknown');
          for (const pair of owner.drainedF06Originals ?? []) {
            require(Array.isArray(pair) && pair.length === 2 && pair[1] instanceof modules.base.ServerTableEngineBase,
              'mixed_pending_source_maps_unknown');
            require(pair[0] !== tableId && pair[1].tableId !== tableId, 'mixed_pending_source_present');
          }
          require(owner.pendingTableBreakRetirement === null || (record(owner.pendingTableBreakRetirement) &&
            owner.pendingTableBreakRetirement.engine instanceof modules.base.ServerTableEngineBase &&
            owner.pendingTableBreakRetirement.tableId === owner.pendingTableBreakRetirement.engine.tableId), 'mixed_pending_source_maps_unknown');
          require(owner.pendingTableBreakRetirement?.tableId !== tableId &&
            owner.pendingTableBreakRetirement?.engine?.tableId !== tableId, 'mixed_pending_source_present');
          managers.push({tournament_id: tournamentId, manager_id: owner.managerLifecycleDiagnostics.instanceId, absent: true});
        }
        return {kind: 'all_current_engine_maps_absent_v1', source: release, instance_id: options.expectedInstanceId,
          table_id: tableId, global_absent: true, owned_absent: true, retirement_absent: true,
          managers: managers.sort((a,b) => a.manager_id.localeCompare(b.manager_id))};
      };
      const bankRows = new Map();
      const pending = [];
      /* ═══ A SEALED CUSTODY TRANSFER IS NOT TRANSFERRED TWICE (2026-09-25) ═══

         Run 36144233010 is the measurement. The publisher gave up on this
         guard's call (`inspector operation outcome unknown`, stage
         `mixed_custody`, 65 tables bank-checkpointed and verified) while the
         guard went on inside the engine and FINISHED: both transfers were
         committed (`f06_manager_custody_transfers` holds 5a387a75 under
         origin generation 66291622 and 615783bf under b3d06bad) and both
         originals were retired through `unregisterTournamentTableEngine`,
         which is why `/health.maintenance` went from
         `{f06_preparation_unresolved: 1}` to `unparkedTables: 0`.

         The release transaction requires this checkpoint again on every
         release while the sealed predecessor is 8825, and each run carries a
         FRESH `transfer_id`/`successor_generation` pair per manager. What the
         next run meets in-process: 8825 `unregisterOwnedTournamentTableEngine`
         deletes from `GameServer.tableEngines` and `tournamentOwnedTables`
         only (TournamentManagerOwnership.ts:60-72); the manager's own
         `tableEngines`, `retainedTournamentBreakSources` and
         `drainedF06Originals` are untouched, because the stop retry that
         would delete them (TournamentManagerBase.ts:5836-5839) throws
         `retained an unresolved seat-move UUID` first, every ~5 s, for ever.
         So `captureDrainedF06Originals()` still answers the same engines, the
         manager is still in `tournamentEngines` (a failed
         `stopOwnedTournamentManager` keeps the slot, :86-101), and the
         capture below refuses `mixed_original_registry_disagreement` at
         `tableMap.get(tableId) === engine` before any RPC - and had it not,
         the observe call would have refused `F06_MIXED_TRANSFER_CHANGED`
         (migration 20260921155216 L181-182: the prior row's ids must equal
         the call's, and the intent's are new). Every future release would die
         at a checkpoint whose work is done: the forever block one level up
         (CLAUDE.md 10.86 rule 4), made by this guard.

         So the ROWS are asked first, per retained manager and before any
         prepare call. `fn_f06_find_mixed_manager_custody` returns the one
         open transfer for the tournament. A receipt whose `origin_generation`
         is this manager's lease generation, and whose `local_proof` names
         this exact process (release, instance, container, pid) and this
         exact manager, is a transfer THIS guard sealed. Such a manager makes
         no observe and no commit; the intent's fresh ids for it are simply
         unused; its originals are not required to be registered or drained,
         because they were retired; and an original that is STILL registered
         under the exact engine identity the row names is retired through the
         same CAS, since that is the one step the sealing run had left and the
         rows already hold its custody. A receipt for another generation is
         not this manager's seal and takes the full path exactly as before. A
         receipt for this generation that names another process or manager
         refuses, named, rather than reaching the database's refusal. A lookup
         that did not answer, or found nothing, decides nothing: the manager
         stays on the existing path, whose own refusals are unchanged.
         Nothing in this lookup writes, and no check a manager that is NOT
         sealed meets has moved. */
      const prefix = (value) =>
        uuid(value) || /^[0-9a-f]{64}$/.test(String(value)) ? String(value).slice(0, 8) : describe(value);
      const sealedTransfer = async (manager) => {
        const note = (outcome) => {
          sealedLookups.push(`${String(manager.tournamentId).slice(0, 8)}:${outcome}`);
          sealedLookup = sealedLookups.join(' ').slice(0, 512);
        };
        /* THE LOOKUP NEVER REFUSES AN UNSEALED MANAGER. It is a read made
           ahead of a path that already has every refusal it needs: a lookup
           that did not come back, came back as something that is not a
           record, found no row, or found another generation's row, leaves the
           manager on the exact existing path - drain sweep, observe, commit -
           where the database itself still refuses `F06_MIXED_TRANSFER_CHANGED`
           against any transfer this run did not make. Only a positive receipt
           for this generation decides anything, and that decision is made by
           the witness below. What the lookup answered travels in
           `sealedLookup`; nothing reads it. */
        checkMaintenance();
        let response;
        try {
          response = await modules.client.supabase.rpc('fn_f06_find_mixed_manager_custody', {
            p_tournament_id: manager.tournamentId,
          });
        } catch {
          response = null;
        }
        checkMaintenance();
        if (response === null || response === undefined || response.error) {
          note('unanswered');
          return null;
        }
        if (!record(response.data) || response.data.ok !== true) {
          note('malformed');
          return null;
        }
        const receipt = response.data.receipt ?? null;
        if (receipt === null) {
          note('none');
          return null;
        }
        if (!record(receipt)) {
          note('malformed');
          return null;
        }
        if (receipt.origin_generation !== manager.tournamentLeaseGeneration) {
          note('other_generation');
          return null;
        }
        note('sealed');
        const checkpoint = receipt.local_proof?.release_checkpoint;
        witness(
          'mixed_sealed_transfer_foreign',
          [
            ['receipt.tournament_id', () => receipt.tournament_id === manager.tournamentId],
            ['receipt.transfer_id', () => uuid(receipt.transfer_id)],
            [
              'receipt.successor_generation',
              () =>
                uuid(receipt.successor_generation) &&
                receipt.successor_generation !== manager.tournamentLeaseGeneration,
            ],
            ['receipt.local_proof', () => record(receipt.local_proof) && record(checkpoint)],
            ['receipt.canonical_proof', () => record(receipt.canonical_proof)],
            ['release_checkpoint.kind', () => checkpoint.kind === 'legacy_engine_checkpoint_8825_v1'],
            ['release_checkpoint.source', () => checkpoint.source === release],
            [
              'release_checkpoint.instance_id',
              () => checkpoint.instance_id === options.expectedInstanceId,
            ],
            ['release_checkpoint.container_id', () => checkpoint.container_id === intent.container],
            ['release_checkpoint.process_id', () => checkpoint.process_id === options.expectedPid],
            [
              'local_proof.manager_id',
              () =>
                receipt.local_proof.manager_id === manager.managerLifecycleDiagnostics.instanceId,
            ],
          ],
          () => ({
            failedTable: manager.tournamentId,
            // Identifier prefixes only, as the other custody records carry
            // them; anything not uuid-shaped is reduced by `describe`.
            observed: prefix(receipt.transfer_id),
            observedDetail: [
              `origin=${prefix(receipt.origin_generation)}`,
              `instance=${describe(checkpoint?.instance_id)}`,
              `container=${prefix(checkpoint?.container_id)}`,
              `manager=${prefix(receipt.local_proof?.manager_id)}`,
              `expectedManager=${prefix(manager.managerLifecycleDiagnostics?.instanceId)}`,
            ]
              .join(',')
              .slice(0, 512),
          })
        );
        return detached(receipt);
      };
      const retainSealed = (manager, proposal, receipt) => {
        const named = receipt.local_proof.engines;
        require(Array.isArray(named) &&
          named.length > 0 &&
          named.length <= maxTables &&
          named.every((row) => record(row) && uuid(row.table_id) && uuid(row.engine_id)) &&
          new Set(named.map((row) => row.table_id)).size === named.length, 'mixed_sealed_receipt_shape');
        // The row is the record of what was transferred. A stopped manager can
        // admit nothing, so every engine it still holds must be one the row
        // names, under the same engine identity; anything else is not a seal
        // this guard made.
        require(manager.tableEngines instanceof Map &&
          manager.tableEngines.size <= maxTables &&
          [...manager.tableEngines].every(([id, engine]) =>
            named.some(
              (row) => row.table_id === id && row.engine_id === engine?.lifecycleDiagnostics?.instanceId
            )
          ), 'mixed_sealed_original_unnamed');
        const exactEngines = [];
        for (const row of named) {
          const tableId = row.table_id;
          const engine = tableMap.get(tableId);
          if (engine === undefined) {
            // The sealing run's CAS already ran for this table. 8825 deletes
            // the global slot and the owned mark together or not at all
            // (TournamentManagerOwnership.ts:66-70), so a table gone from one
            // and not the other is not something this guard did.
            require(!ownedTables.has(tableId), 'mixed_sealed_original_registry_disagreement');
            retiredOriginals.add(tableId);
            continue;
          }
          // Still registered: the sealing run committed its row and did not
          // reach this table's CAS. Only the exact stopped, terminal engine the
          // row names, held by this manager, is retired - never a replacement
          // behind the same table id.
          require(!retained.has(engine) &&
            engine instanceof modules.base.ServerTableEngineBase &&
            engine.tableId === tableId &&
            engine.lifecycleDiagnostics?.instanceId === row.engine_id &&
            ownedTables.has(tableId) &&
            manager.tableEngines.get(tableId) === engine &&
            engine.running === false &&
            engine.terminal === true &&
            engine.hasReleasedProcessOwnership() === true, 'mixed_sealed_original_registry_disagreement');
          retained.add(engine);
          exactEngines.push({ tableId, engine });
        }
        sealedManagers++;
        retainedManagers.push({
          manager,
          proposal,
          sealed: true,
          receipt,
          exactEngines,
          capturedLeaseGeneration: manager.tournamentLeaseGeneration,
        });
      };
      for (const proposal of intent.custody) {
        const manager = managerMap.get(proposal.tournament_id);
        require(manager instanceof modules.manager.TournamentManager &&
          manager.gameServer === server &&
          manager.tournamentId === proposal.tournament_id &&
          uuid(manager.tournamentLeaseGeneration) &&
          manager.tournamentLeaseGeneration !== proposal.successor_generation &&
          uuid(manager.managerLifecycleDiagnostics?.instanceId) &&
          uuid(manager.tournamentMoveBoundaryOwner), 'mixed_manager_identity');
        boundMethods(manager, manager.tournamentId, manager.tournamentLeaseGeneration, [
          'captureDrainedF06Originals',
        ]);
        // Rows first. A manager this guard already sealed takes none of the
        // drain, registry or receipt requirements below: they describe custody
        // that has already moved.
        const sealed = await sealedTransfer(manager);
        if (sealed !== null) {
          retainSealed(manager, proposal, sealed);
          continue;
        }
        const originals = manager.captureDrainedF06Originals();
        require(Array.isArray(originals) &&
          originals.length > 0 &&
          originals.length <= maxTables &&
          manager.tableEngines instanceof Map &&
          manager.tableEngines.size === originals.length &&
          manager.tournamentSeatMoveSerialTail instanceof Promise &&
          manager.retainedTournamentBreakSources instanceof Map &&
          manager.retainedTournamentBreakSources.size > 0 &&
          manager.activeStoppedOriginalCustody instanceof Set &&
          manager.activeStoppedOriginalCustody.size === 0, 'mixed_manager_not_drained');
        for (const name of emptySets)
          require(manager[name] instanceof Set &&
            manager[name].size === 0, 'mixed_manager_work_pending');
        require(manager.tableEngineRecoveryTimers instanceof Map &&
          manager.tableEngineRecoveryTimers.size === 0, 'mixed_manager_recovery_pending');
        const exactMaps = Object.fromEntries(
          [
            ...Object.values(mapKeys),
            'tableEngines',
            'retainedTournamentBreakSources',
            'pendingNoStartContinuations',
            'stoppedOriginalBreaks',
            'tournamentBreakArrivalWakes',
            'tableEngineRecoveryTimers',
          ].map((name) => {
            require(manager[name] instanceof Map, 'mixed_map_incomplete');
            return [name, manager[name]];
          })
        );
        const exactSets = Object.fromEntries(emptySets.map((name) => [name, manager[name]]));
        const exactMapEntries = Object.fromEntries(
          Object.entries(exactMaps).map(([name, map]) => [name, [...map]])
        );
        const exactRetirement = manager.pendingTableBreakRetirement;
        const captureMethod = manager.captureDrainedF06Originals;
        // The custody this checkpoint retires is named by the manager's
        // tournament and lease generation (the RPC input and its receipt) and
        // by the engines' identities. Those are what is pinned below. The seat
        // move authority revision and serial tail are NOT: the live 8825
        // lease-loss pass re-runs `stopTournamentManagerIfOwned` every ~5 s for
        // the retained managers, and each retry bumps the revision, replaces
        // the serial tail and rebuilds a frozen `drainedF06Originals` array
        // with the same engines in it - none of which moves custody.
        const capturedTournamentId = manager.tournamentId;
        const capturedLeaseGeneration = manager.tournamentLeaseGeneration;
        // A stop retry's `captureDrainedF06Originals()` returns null while its
        // `teardownPromise` is set, then the same engines again. Custody rests
        // on the engines' identities, so the witness compares contents, and a
        // transient null is tolerated: the map/engine witnesses below still
        // pin every original.
        const sameOriginals = () => {
          const now = manager.captureDrainedF06Originals();
          return (
            now === null ||
            (Array.isArray(now) &&
              now.length === originals.length &&
              now.every(([id, e], i) => originals[i][0] === id && originals[i][1] === e))
          );
        };
        // Which of these seven terms refused is the one thing run 36144951750
        // (2026-09-25, stage preflight, attemptedTables 0) could not say: a
        // bare conjunction refuses under one code and names nothing. Nothing
        // is widened and nothing is re-captured here, because a false term is
        // NOT a stale capture: `captureDrainedF06Originals()` above and every
        // read below run in one synchronous turn with no await between them,
        // so a term that is false is a STANDING disagreement between this
        // manager's own map and the two process registries - a state the
        // release is right to refuse. The exact original sub-expressions, in
        // the exact original left-to-right order, under the original code.
        const exactEngines = originals.map(([tableId, engine], originalIndex) => {
          const slot = (map, expected) =>
            !(map instanceof Map)
              ? 'unreadable'
              : !map.has(tableId)
                ? 'absent'
                : map.get(tableId) === expected
                  ? 'same'
                  : 'other';
          /* One original out of step is a table that left the fleet under a
             manager that still holds it; ALL of them is a custody handoff that
             took the whole manager. The next refusal should not need a third
             release to tell those two apart. Read defensively: a detail that
             throws costs every other field on the receipt. */
          const disagreeing = () => {
            try {
              let count = 0;
              for (const pair of originals)
                if (
                  !Array.isArray(pair) ||
                  tableMap.get(pair[0]) !== pair[1] ||
                  !ownedTables.has(pair[0])
                )
                  count += 1;
              return `${count}/${originals.length}`;
            } catch {
              return 'unreadable';
            }
          };
          witness(
            'mixed_original_registry_disagreement',
            [
              ['original.tableId', () => uuid(tableId)],
              ['original.distinctEngine', () => !retained.has(engine)],
              ['fleet.tableEngines', () => tableMap.get(tableId) === engine],
              ['fleet.tournamentOwnedTables', () => ownedTables.has(tableId)],
              ['manager.tableEngines', () => manager.tableEngines.get(tableId) === engine],
              ['engine.prototype', () => engine instanceof modules.base.ServerTableEngineBase],
              ['engine.tableId', () => engine.tableId === tableId],
            ],
            () => ({
              failedTable: uuid(tableId) ? tableId : describe(tableId),
              failedField: 'drainedF06Originals',
              observed: `fleet:${slot(tableMap, engine)}`,
              expected: 'fleet:same',
              /* `failedTournament` is not a carried key (#5034), so the
                 tournament travels here - and beside it the three registry
                 slots, so ONE receipt says which registry disagreed, which
                 way, and whether the id was retired out from under it rather
                 than replaced. Shapes, sizes and uuids only. */
              observedDetail: [
                `tournament=${
                  uuid(manager.tournamentId) ? manager.tournamentId : describe(manager.tournamentId)
                }`,
                `table=${uuid(tableId) ? tableId : describe(tableId)}`,
                `index=${originalIndex + 1}/${originals.length}`,
                `fleetSlot=${slot(tableMap, engine)}`,
                `owned=${describe(ownedTables.has(tableId))}`,
                `managerSlot=${slot(manager.tableEngines, engine)}`,
                `duplicate=${describe(retained.has(engine))}`,
                `prototype=${describe(engine instanceof modules.base.ServerTableEngineBase)}`,
                `engineTable=${uuid(engine?.tableId) ? engine.tableId : describe(engine?.tableId)}`,
                `heldRetired=${describe(retirement.held.has(tableId))}`,
                `pendingRetired=${describe(retirement.pending.has(tableId))}`,
                `activeRetired=${describe(retirement.active.has(tableId))}`,
                `fleetSize=${describe(tableMap.size)}`,
                `ownedSize=${describe(ownedTables.size)}`,
                `managerEngines=${describe(manager.tableEngines.size)}`,
                `fleetDisagree=${disagreeing()}`,
              ]
                .join(',')
                .slice(0, 512),
            })
          );
          retained.add(engine);
          const permit = engine.f06CurrentPermit;
          require(permit === null ||
            (permit instanceof modules.permit.F06HandPermit &&
              Object.isFrozen(permit.binding) &&
              permit.binding.tournament_id === manager.tournamentId &&
              permit.binding.lease_generation === manager.tournamentLeaseGeneration &&
              permit.binding.table_id === tableId &&
              uuid(permit.binding.permit_id) &&
              uuid(permit.binding.custody_id) &&
              permit.reserveInFlight === false &&
              permit.preparedCancellation === false &&
              permit.recoveryState ===
                modules.permit.F06HandPermit.prototype
                  .recoveryState), 'mixed_original_permit_unproven');
          // 8825 predates f06TableLifecycle. Use its retained original witness,
          // never a field introduced by the replacement engine.
          const retainedSource = manager.retainedTournamentBreakSources.get(tableId);
          const lifecycleWitnesses = [
            permit?.binding.lifecycle,
            engine.f06MovementAdmission?.receipt.lifecycle,
            retainedSource
              ? manager.durableTournamentBreaks.get(retainedSource.breakId)?.lifecycle
              : undefined,
          ].filter((value) => value !== undefined && value !== null);
          const lifecycle = lifecycleWitnesses[0] ?? null;
          require(lifecycleWitnesses.every(
            (value) => value === lifecycle
          ), 'mixed_original_lifecycle_disagrees');
          const allocationEpoch = engine.f06AllocationEpoch;
          require(allocationEpoch === null ||
            (uuid(allocationEpoch) &&
              typeof engine.f06Allocator === 'function' &&
              typeof engine.f06AllocationCurrent === 'function' &&
              typeof engine.f06PermitFactory === 'function'), 'mixed_original_allocation_unproven');
          require(((typeof lifecycle === 'string' && /^[1-9][0-9]{0,18}$/.test(lifecycle)) ||
            (lifecycle === null && permit === null && uuid(allocationEpoch))) &&
            uuid(engine.lifecycleDiagnostics?.instanceId), 'mixed_original_lifecycle_unproven');
          for (const name of serialFields)
            require(engine[name] instanceof Promise, 'mixed_original_stop_unproven');
          return {
            tableId,
            engine,
            permit,
            lifecycle,
            allocationEpoch,
            allocation: [engine.f06Allocator, engine.f06AllocationCurrent, engine.f06PermitFactory],
            movementAdmission: engine.f06MovementAdmission,
            permitBinding: permit?.binding,
            phase: permit?.recoveryState() ?? null,
            methods: boundMethods(engine, manager.tournamentId, manager.tournamentLeaseGeneration, [
              'hasReleasedProcessOwnership',
              'hasOnlyDrainedTournamentMoveOwner',
            ]),
            queues: serialFields.map((name) => engine[name]),
            collections: [...engineSets, ...engineMaps].map((name) => engine[name]),
            banks: [
              engine.timeBankMeta,
              engine.timeBankEngine,
              engine.timeBankEngine?.playerBanks,
              engine.parkedTimeBanks,
            ],
          };
        });
        const sourceTable = (engine) => {
          const value = exactEngines.find((item) => item.engine === engine);
          require(value, 'mixed_foreign_original');
          return value;
        };
        const reservations = () => {
          const result = [];
          for (const [tableId, identity] of retirement.pending) {
            require(typeof identity === 'string', 'mixed_retirement_binding');
            const binding = JSON.parse(identity);
            require(Array.isArray(binding) && binding.length === 7, 'mixed_retirement_binding');
            if (binding[0] !== manager.tournamentId) continue;
            require(binding[4] === manager.tournamentLeaseGeneration &&
              binding[2] === tableId &&
              exactEngines.some((v) => v.tableId === tableId) &&
              !retirement.active.has(tableId) &&
              retirement.held.has(tableId), 'mixed_retirement_unproven');
            result.push({ table_id: tableId, revision: retirement.held.get(tableId), binding });
          }
          require(exactEngines.every(
            ({ tableId }) =>
              !retirement.held.has(tableId) || result.some((r) => r.table_id === tableId)
          ), 'mixed_retirement_unproven');
          return result.sort((a, b) => a.table_id.localeCompare(b.table_id));
        };
        const physical = (capture) => {
          const { tableId, engine, permit, lifecycle } = capture;
          // Observability only. The one original conjunction below is split into
          // its exact sub-expressions, evaluated in the exact original
          // left-to-right order, each refusing with the exact original code.
          // `drained` is `require` with a name attached: no condition text, no
          // threshold and no set of checks changed, and nothing extra is read on
          // a path where the original conjunction short-circuited.
          const drained = (condition, failedCheck, observed, expected, extra) => {
            if (condition) return;
            noteRefusal(() => ({
              failedCheck,
              failedTable: tableId,
              observed: describe(observed),
              expected,
              ...(extra === undefined ? {} : extra()),
            }));
            refuse('mixed_original_work_not_drained');
          };
          const running = engine.running;
          drained(running === false, 'engine.running', running, 'false');
          const terminal = engine.terminal;
          drained(terminal === true, 'engine.terminal', terminal, 'true');
          const terminalTeardownComplete = engine.terminalTeardownComplete;
          drained(
            terminalTeardownComplete === true,
            'engine.terminalTeardownComplete',
            terminalTeardownComplete,
            'true'
          );
          const releasedProcessOwnership = engine.hasReleasedProcessOwnership();
          drained(
            releasedProcessOwnership === true,
            'engine.hasReleasedProcessOwnership()',
            releasedProcessOwnership,
            'true'
          );
          const stillLive = modules.base.ServerTableEngineBase.liveEngines.has(tableId);
          drained(!stillLive, 'base.liveEngines.has(tableId)', stillLive, 'false');
          const dealingLoopPromise = engine.dealingLoopPromise;
          drained(
            dealingLoopPromise === null,
            'engine.dealingLoopPromise',
            dealingLoopPromise,
            'null'
          );
          const postHandTasksPromise = engine.postHandTasksPromise;
          drained(
            postHandTasksPromise === null,
            'engine.postHandTasksPromise',
            postHandTasksPromise,
            'null'
          );
          const snapshotFlushPromise = engine.snapshotFlushPromise;
          drained(
            snapshotFlushPromise === null,
            'engine.snapshotFlushPromise',
            snapshotFlushPromise,
            'null'
          );
          const handController = engine.handController;
          drained(handController === null, 'engine.handController', handController, 'null');
          const actionLock = engine.actionLock;
          drained(actionLock === false, 'engine.actionLock', actionLock, 'false');
          const f06HandPreparation = engine.f06HandPreparation;
          drained(
            f06HandPreparation === null,
            'engine.f06HandPreparation',
            f06HandPreparation,
            'null'
          );
          const f06RecoveryInFlight = engine.f06RecoveryInFlight;
          drained(
            f06RecoveryInFlight === false,
            'engine.f06RecoveryInFlight',
            f06RecoveryInFlight,
            'false'
          );
          const terminalBoundaryPersistenceFailed = engine.terminalBoundaryPersistenceFailed;
          drained(
            terminalBoundaryPersistenceFailed === false,
            'engine.terminalBoundaryPersistenceFailed',
            terminalBoundaryPersistenceFailed,
            'false'
          );
          const timeBankAccountingUnconfirmed = engine.timeBankAccountingUnconfirmed;
          drained(
            timeBankAccountingUnconfirmed === false,
            'engine.timeBankAccountingUnconfirmed',
            timeBankAccountingUnconfirmed,
            'false'
          );
          const engineLeaseScope = engine.engineLeaseScope;
          drained(
            engineLeaseScope === 'tournament',
            'engine.engineLeaseScope',
            engineLeaseScope,
            'tournament'
          );
          const engineLeaseVerified = engine.engineLeaseVerified;
          drained(
            engineLeaseVerified === true,
            'engine.engineLeaseVerified',
            engineLeaseVerified,
            'true'
          );
          const engineLeaseTournamentId = engine.engineLeaseTournamentId;
          drained(
            engineLeaseTournamentId === manager.tournamentId,
            'engine.engineLeaseTournamentId',
            engineLeaseTournamentId,
            'manager.tournamentId'
          );
          const engineLeaseGeneration = engine.engineLeaseGeneration;
          drained(
            engineLeaseGeneration === manager.tournamentLeaseGeneration,
            'engine.engineLeaseGeneration',
            engineLeaseGeneration,
            'manager.tournamentLeaseGeneration'
          );
          const f06AllocationEpoch = engine.f06AllocationEpoch;
          drained(
            f06AllocationEpoch === capture.allocationEpoch,
            'engine.f06AllocationEpoch',
            f06AllocationEpoch,
            'captured allocation epoch'
          );
          const allocationMethods = [
            engine.f06Allocator,
            engine.f06AllocationCurrent,
            engine.f06PermitFactory,
          ];
          drained(
            allocationMethods.every((method, index) => method === capture.allocation[index]),
            'engine.f06AllocationMethods',
            allocationMethods,
            'captured allocation method identity',
            () => ({
              failedField: ['f06Allocator', 'f06AllocationCurrent', 'f06PermitFactory'][
                allocationMethods.findIndex((method, index) => method !== capture.allocation[index])
              ],
            })
          );
          const f06MovementAdmission = engine.f06MovementAdmission;
          drained(
            f06MovementAdmission === capture.movementAdmission,
            'engine.f06MovementAdmission',
            f06MovementAdmission,
            'captured movement admission identity'
          );
          const f06CurrentPermit = engine.f06CurrentPermit;
          drained(
            f06CurrentPermit === permit,
            'engine.f06CurrentPermit',
            f06CurrentPermit,
            'captured permit identity'
          );
          const permitBinding = permit?.binding;
          drained(
            permitBinding === capture.permitBinding,
            'permit.binding',
            permitBinding,
            'captured permit binding identity'
          );
          const permitPhase = permit?.recoveryState() ?? null;
          drained(
            permitPhase === capture.phase,
            'permit.recoveryState()',
            permitPhase,
            'captured permit phase'
          );
          if (permit !== null) {
            const reserveInFlight = permit.reserveInFlight;
            drained(reserveInFlight === false, 'permit.reserveInFlight', reserveInFlight, 'false');
            const preparedCancellation = permit.preparedCancellation;
            drained(
              preparedCancellation === false,
              'permit.preparedCancellation',
              preparedCancellation,
              'false'
            );
            const recoveryStateMethod = permit.recoveryState;
            drained(
              recoveryStateMethod === modules.permit.F06HandPermit.prototype.recoveryState,
              'permit.recoveryStateMethod',
              recoveryStateMethod,
              'F06HandPermit.prototype.recoveryState'
            );
          }
          let failedSerialField = null;
          let failedSerialValue;
          const serialQueuesIntact = serialFields.every((name, index) => {
            const value = engine[name];
            if (value === capture.queues[index]) return true;
            failedSerialField = name;
            failedSerialValue = value;
            return false;
          });
          drained(
            serialQueuesIntact,
            'engine.serialQueueIdentity',
            failedSerialValue,
            'captured queue identity',
            () => ({ failedField: failedSerialField })
          );
          const drainMethods = [
            engine.hasReleasedProcessOwnership,
            engine.hasOnlyDrainedTournamentMoveOwner,
          ];
          drained(
            drainMethods.every((method, index) => method === capture.methods[index]),
            'engine.drainMethodIdentity',
            drainMethods,
            'captured method identity',
            () => ({
              failedField: ['hasReleasedProcessOwnership', 'hasOnlyDrainedTournamentMoveOwner'][
                drainMethods.findIndex((method, index) => method !== capture.methods[index])
              ],
            })
          );
          const onlyDrainedMoveOwner = engine.hasOnlyDrainedTournamentMoveOwner(
            manager.tournamentMoveBoundaryOwner
          );
          drained(
            onlyDrainedMoveOwner === true,
            'engine.hasOnlyDrainedTournamentMoveOwner(manager.tournamentMoveBoundaryOwner)',
            onlyDrainedMoveOwner,
            'true',
            () => {
              // That native predicate collapses six clauses into one boolean and
              // the read-only diagnostics API does not expose them. Read the same
              // six inputs back here, so a refusal names the clause rather than
              // the method. Sizes and booleans only; no owner value is emitted.
              const owner = manager.tournamentMoveBoundaryOwner;
              const sizeOf = (value) =>
                value instanceof Set || value instanceof Map ? value.size : null;
              const agreement = (value) => {
                if (!(value instanceof Set)) return 'absent';
                let matching = 0;
                for (const held of value) if (held === owner) matching += 1;
                return `size=${value.size}/allMatchBoundaryOwner=${matching === value.size}`;
              };
              return {
                observedDetail: [
                  `terminalTeardownComplete=${terminalTeardownComplete === true}`,
                  `notRunning=${running === false}`,
                  `tournamentMoveOperations=${sizeOf(engine.tournamentMoveOperations)}`,
                  `tournamentMoveOperationByOwner=${sizeOf(engine.tournamentMoveOperationByOwner)}`,
                  `claimedTournamentMovePauseOwners=${agreement(engine.claimedTournamentMovePauseOwners)}`,
                  `tournamentMovePauseOwners=${agreement(engine.tournamentMovePauseOwners)}`,
                ].join(','),
              };
            }
          );
          // An original interrupted mid-hand still holds the integer that
          // `beginTerminalBoundaryPersistence` reserved immediately before
          // HandController.start. The single site that removes it,
          // `finishTerminalBoundaryPersistence`, is reached only from the hand's
          // own settlement; on a stopped engine `lifecycleCanMutate()` is
          // permanently false, so the `hand_history` step returns before it runs
          // and no timer, job, successor or database row can ever reach it again.
          // The reserved integer therefore IS the interruption this checkpoint
          // exists to hand over, not work still draining - every other drain
          // predicate above has already proved nothing is in flight, and a
          // boundary that was attempted and lost would have set
          // `terminalBoundaryPersistenceFailed`, which is refused above.
          //
          // The phase that holds it is `attempted`, and only `attempted`.
          // `beginTerminalBoundaryPersistence` has exactly one call site,
          // `startExactController` in ServerTableEngineDealing, and on an engine
          // holding a permit that site runs inside `F06HandPermit.start`, which
          // sets `phase = 'attempted'` on the line before it actuates. So the
          // integer cannot exist while the phase is `new`, `reserved`, `unknown`
          // or `number_refused` - it had not been reserved yet - and the phase
          // cannot leave `attempted` afterwards: `terminateUnstarted` throws
          // `f06_hand_may_have_started` on it, `cancelPreparedHand` requires
          // `reserved` (and `preparedCancellation` is proved false above), and
          // the settle path that would accept it runs inside the hand's own
          // settlement, which `lifecycleCanMutate()` has permanently closed.
          // `attempted` is therefore the exact and only phase of the
          // interruption this checkpoint exists to hand over.
          //
          // Admit it ONLY for an engine that still holds the undischarged permit
          // of that hand, whose live phase was proved equal to the captured phase
          // through the unmodified `F06HandPermit.prototype.recoveryState` above.
          // That is not a waiver: `sealAndRetireOriginals` refuses this whole run
          // with `mixed_original_disposition_unproven` unless the database proves
          // that same permit `aborted_unsettled` against a committed receipt
          // naming this exact engine, manager and container - and it does so
          // before the custody RPC and before the retirement CAS, so an
          // undischarged interruption still reaches no irreversible step. Nothing
          // is written for a retained original before that proof, and this change
          // adds `attempted` to the phases that proof is demanded of, so nothing
          // admitted here escapes it.
          const interrupted = permit !== null && capture.phase === 'attempted';
          [...engineSets, ...engineMaps].forEach((name, index) => {
            const collection = engine[name];
            const captured = capture.collections[index];
            drained(
              collection === captured,
              'engineCollection.identity',
              collection,
              'captured collection identity',
              () => ({ failedField: name })
            );
            const size = collection.size;
            // THREE OUTCOMES ON THIS ONE FIELD, NOT TWO (merged 2026-09-21).
            // #5020 and #5021 answer different questions about the same set and
            // THE PERMIT IS WHAT SEPARATES THEM, so neither can mask the other:
            //
            //   permit !== null && phase === 'attempted'  -> #5020 ADMITS ONE.
            //     `beginTerminalBoundaryPersistence` has one call site and on an
            //     engine holding a permit it runs inside `F06HandPermit.start`,
            //     one line after the phase becomes `attempted`. So the integer IS
            //     that started, cut-off hand, and `sealAndRetireOriginals` demands
            //     an `aborted_unsettled` receipt naming this engine, manager and
            //     container before anything irreversible.
            //   permit !== null && phase !== 'attempted'  -> REFUSE, `expected` 0,
            //     before any row read and before any RPC. By the same argument the
            //     integer cannot exist in those phases at all, so this combination
            //     is an engine we do not understand - exactly the case to fail
            //     closed on, never to defer.
            //   permit === null                           -> #5021 DEFERS. #5020's
            //     argument is about an engine HOLDING a permit; with none there is
            //     no phase to reason from and no outstanding hand, so nothing
            //     downstream of HAND_COMPLETE can ever resolve the generation. It
            //     is abandoned, and `proveAbandonedBoundaries` proves the felt
            //     quiet from rows before anything is retired.
            //
            // Gating the deferral on `permit === null` leaves #5020 byte-for-byte
            // wherever a permit exists, including its refusal and its reported
            // `expected`, and covers only the gap its phase argument cannot reach.
            // Measured on engine 8825af51: under #5011's older triple, table
            // 2c621856 refused four times with `expected:"0"`; on #5020's SHA
            // (`db885b29`) the refusal moved off this field entirely, which is
            // what an admitted `attempted` generation looks like. The deferral
            // below is therefore dormant for that table and is the net under it.
            if (size !== 0 && name === 'terminalBoundaryPendingGenerations' && permit === null) {
              // A generation is opened immediately before HandController.start
              // and removed only downstream of HAND_COMPLETE. `handController`
              // is null on this engine - proved above - so no HAND_COMPLETE can
              // dispatch here and no resolver can ever run. This count cannot
              // reach zero however long anyone waits: it says "pending" while
              // the truth is "abandoned, and nothing will ever resolve me"
              // (CLAUDE.md 10.86). Refusing on it forever is how one derelict
              // table held 70 consecutive cutovers shut.
              //
              // It is NOT waved through here. This function is synchronous and
              // cannot ask the database, and a drain check satisfied with no
              // row read is exactly the hazard this gate exists to prevent. So
              // the table is DEFERRED, and `proveAbandonedBoundaries` refuses
              // the whole checkpoint unless rows prove the felt is quiet for it
              // - before `sealAndRetireOriginals` retires anything.
              const generations = collection instanceof Set ? [...collection] : [];
              drained(
                collection instanceof Set &&
                  size <= maxEntriesPerTable &&
                  generations.every((value) => Number.isSafeInteger(value) && value > 0) &&
                  // Every conjunct below was read above and already refused on;
                  // they are restated so the deferral is legible in one place
                  // and cannot outlive the drain proof it depends on.
                  running === false &&
                  terminal === true &&
                  terminalTeardownComplete === true &&
                  releasedProcessOwnership === true &&
                  handController === null &&
                  dealingLoopPromise === null &&
                  postHandTasksPromise === null &&
                  snapshotFlushPromise === null &&
                  f06HandPreparation === null &&
                  f06RecoveryInFlight === false &&
                  // "Did not succeed" is a different claim, checked one step
                  // earlier. An abandoned boundary never asserts it.
                  terminalBoundaryPersistenceFailed === false,
                'engineCollection.abandonedShape',
                size,
                'an unreachable generation on a fenced, fully drained engine',
                () => ({ failedField: name })
              );
              const signature = canonical([...generations].sort((a, b) => a - b));
              const previous = deferredAbandonedBoundaries.get(tableId);
              // physical() runs again on every re-verification. A set that
              // MOVED is a live boundary, not the abandoned one that was
              // proved, and it refuses with the original code.
              drained(
                previous === undefined || previous.signature === signature,
                'engineCollection.abandonedChanged',
                size,
                'the exact generations first observed',
                () => ({ failedField: name })
              );
              deferredAbandonedBoundaries.set(tableId, { signature, count: generations.length });
            } else {
              // Exactly one hand can be outstanding on a terminal engine, so the
              // allowance is one entry on one field. For every other field, and for
              // this field on an engine with no undischarged permit, `allowed` is 0
              // and `size <= 0` is `size === 0` - including a malformed collection
              // whose `size` is undefined - so the refusal, its order and its
              // reported `expected` are unchanged.
              const allowed = name === 'terminalBoundaryPendingGenerations' && interrupted ? 1 : 0;
              drained(size <= allowed, 'engineCollection.size', size, String(allowed), () => ({
                failedField: name,
                // Observability only. The allowance on this one field turns on the
                // permit phase, so a refusal here is unreadable without it.
                // It travels in `observedDetail`, the carried key, not in one of
                // its own: an unlisted key is dropped before anyone reads it.
                ...(name === 'terminalBoundaryPendingGenerations'
                  ? {
                      observedDetail: `permitPhase=${
                        capture.phase === null ? 'none' : capture.phase
                      }`,
                    }
                  : {}),
              }));
            }
            const expectSet = engineSets.includes(name);
            drained(
              expectSet ? collection instanceof Set : collection instanceof Map,
              'engineCollection.type',
              collection,
              expectSet ? 'Set' : 'Map',
              () => ({ failedField: name })
            );
          });
          require(engine.timeBankMeta === capture.banks[0] &&
            engine.timeBankEngine === capture.banks[1] &&
            engine.timeBankEngine?.playerBanks === capture.banks[2] &&
            engine.parkedTimeBanks === capture.banks[3] &&
            engine.timeBankMeta instanceof Map &&
            engine.timeBankEngine.playerBanks instanceof Map &&
            engine.timeBankEngine.playerBanks.size === 0 &&
            record(engine.parkedTimeBanks) &&
            Array.isArray(engine.seatedPlayers) &&
            engine.seatedPlayers.length <= maxEntriesPerTable &&
            Number.isSafeInteger(engine.handCount) &&
            engine.handCount >= 0, 'mixed_bank_shape');
          const states = engine.disconnectEngine.getFsmStatesForTable(tableId);
          require(record(states) && Object.keys(states).length === 0, 'mixed_presence_not_drained');
          return {
            table_id: tableId,
            engine_id: engine.lifecycleDiagnostics.instanceId,
            lifecycle,
            allocation_epoch: capture.allocationEpoch,
            permit:
              permit === null ? null : { binding: detached(permit.binding), phase: capture.phase },
            bank_custody: {
              ...(historicalBankLoss[manager.tournamentId]?.generation === manager.tournamentLeaseGeneration
                ? { historical_loss: Object.fromEntries(Object.entries(historicalBankLoss[manager.tournamentId]).filter(([key]) => !['occupants', 'pending_arrivals'].includes(key))) }
                : {}),
              hand_number: engine.handCount,
              roster: engine.seatedPlayers.map((s) => [
                s.user_id,
                s.occupancy_id ?? null,
                s.seat_number,
                s.stack,
              ]),
              time_bank_metadata: sorted(engine.timeBankMeta),
              parked_time_banks: detached(engine.parkedTimeBanks),
              live_time_banks: sorted(engine.timeBankEngine.playerBanks),
              disconnect_states: detached(states),
              durable_presence: bankRows.get(tableId) ?? null,
            },
          };
        };
        const vector = () => ({
          release_checkpoint: {
            kind: 'legacy_engine_checkpoint_8825_v1',
            source: release,
            instance_id: options.expectedInstanceId,
            container_id: intent.container,
            process_id: options.expectedPid,
            run_id: intent.runId,
            control_sha: intent.controlSha,
            ownership_token: maintenanceFence.ownershipToken,
            phase: maintenanceFence.phase,
            announced_at: new Date(maintenanceFence.announcedAt).toISOString(),
            break_started_at: new Date(maintenanceFence.breakStartedAt).toISOString(),
            break_ends_at: new Date(maintenanceFence.breakEndsAt).toISOString(),
            reason: maintenanceFence.reason,
          },
          ...(historicalBankLoss[manager.tournamentId]?.generation === manager.tournamentLeaseGeneration
            ? { historical_loss_pending_arrivals: historicalBankLoss[manager.tournamentId].pending_arrivals.map((original) => ({
              original, absence: absentPendingSource(original.table_id), durable_presence: bankRows.get(original.table_id) ?? null,
            })) } : {}),
          manager_id: manager.managerLifecycleDiagnostics.instanceId,
          move_owner: manager.tournamentMoveBoundaryOwner,
          engines: exactEngines.map(physical),
          retained: sorted(manager.retainedTournamentBreakSources).map(([table_id, value]) => {
            const capture = sourceTable(value.engine);
            require(capture.tableId === table_id &&
              uuid(value.breakId), 'mixed_retained_source_mismatch');
            return {
              table_id,
              break_id: value.breakId,
              engine_id: value.engine.lifecycleDiagnostics.instanceId,
            };
          }),
          ...Object.fromEntries(
            Object.entries(mapKeys).map(([key, name]) => [key, sorted(manager[name])])
          ),
          no_start: sorted(manager.pendingNoStartContinuations).map(([id, value]) => [
            id,
            {
              state: value.state,
              binding: value.binding,
              table_id: value.binding.tableId,
              engine_id: sourceTable(value.engine).engine.lifecycleDiagnostics.instanceId,
            },
          ]),
          stopped_originals: sorted(manager.stoppedOriginalBreaks).map(([id, engine]) => [
            id,
            sourceTable(engine).tableId,
          ]),
          arrival_wakes: sorted(manager.tournamentBreakArrivalWakes).map(([id, map]) => [
            id,
            sorted(map).map(([table, engine]) => [table, sourceTable(engine).tableId]),
          ]),
          retirement: manager.pendingTableBreakRetirement
            ? {
                table_id: manager.pendingTableBreakRetirement.tableId,
                moved_players: manager.pendingTableBreakRetirement.movedPlayers,
                engine_id: sourceTable(manager.pendingTableBreakRetirement.engine).engine
                  .lifecycleDiagnostics.instanceId,
              }
            : null,
          reservations: reservations(),
        });
        const initial = canonical(vector());
        const current = () => {
          // The manager vector is a wide conjunction over live state, so a
          // bare `mixed_owner_changed` names nothing. Split into the exact
          // original sub-expressions, in the exact original order, and report
          // the one that refused plus the map/set or table it refused on.
          const failedMap = () => {
            const found = Object.entries(exactMaps).find(
              ([name, map]) =>
                !(
                  manager[name] === map &&
                  map.size === exactMapEntries[name].length &&
                  exactMapEntries[name].every(([key, value]) => map.get(key) === value)
                )
            );
            return found === undefined ? 'none' : found[0];
          };
          const failedSet = () => {
            const found = Object.entries(exactSets).find(
              ([name, set]) => !(manager[name] === set && set.size === 0)
            );
            return found === undefined ? 'none' : found[0];
          };
          // `captureDrainedF06Originals()` is all-or-nothing: it returns the
          // stable `drainedF06Originals` array, or `null` the moment any one of
          // its thirteen drain conditions stops holding. The identity compare
          // above therefore reports only THAT it flipped, never which condition
          // did it - and that method runs inside the deployed engine, which is
          // the build this release is trying to replace, so it cannot be
          // instrumented from here. Read the same fields it reads, off the same
          // manager, and name the ones that are not in the drained shape.
          // Observability only: every read is a plain property or `.size`.
          const drainWitness = () => {
            const size = (value) => (value && typeof value.size === 'number' ? value.size : -1);
            const flipped = [
              ['drainedF06Originals', () => !manager.drainedF06Originals],
              ['stopFenceApplied', () => !manager.stopFenceApplied],
              ['tournamentLeaseAuthorityExpired', () => !manager.tournamentLeaseAuthorityExpired],
              ['running', () => Boolean(manager.running)],
              ['teardownPromise', () => Boolean(manager.teardownPromise)],
              ['lifecycleOperation', () => Boolean(manager.lifecycleOperation)],
              ['lifecycleJobs', () => size(manager.lifecycleJobs) > 0],
              ['tableEngineStartJobs', () => size(manager.tableEngineStartJobs) > 0],
              ['tableEngineRunJobs', () => size(manager.tableEngineRunJobs) > 0],
              ['eliminationSchedulerJobs', () => size(manager.eliminationSchedulerJobs) > 0],
              ['lifecycleTimeouts', () => size(manager.lifecycleTimeouts) > 0],
              ['lifecycleIntervals', () => size(manager.lifecycleIntervals) > 0],
              [
                'tableEngines.length',
                () =>
                  size(manager.tableEngines) !==
                  (manager.drainedF06Originals ? manager.drainedF06Originals.length : -1),
              ],
              [
                'engineNotDrained',
                () =>
                  (manager.drainedF06Originals ?? []).some(
                    ([id, engine]) =>
                      manager.tableEngines.get(id) !== engine ||
                      engine.isRunning() ||
                      !engine.hasReleasedProcessOwnership() ||
                      engine.hasSettlementInFlight()
                  ),
              ],
            ]
              .map(([name, test]) => {
                // Three outcomes, never one (CLAUDE.md 10.86 rule 1). A term
                // that MOVED names itself. A term that could not be READ is a
                // different fact - still reported, because an unreadable term
                // is still suspicious, but it never wears the name of one that
                // moved, or the next release acts on a finding nobody made.
                try {
                  return test() ? name : null;
                } catch {
                  return `${name}:unreadable`;
                }
              })
              .filter((name) => name !== null);
            // And the fourth, which matters most: the identity compare said the
            // capture flipped and every term below still holds, so the cause is
            // OUTSIDE this list. `none` says that out loud instead of returning
            // an empty string that reads as "nothing was wrong".
            return flipped.length === 0 ? 'none' : flipped.join(',');
          };
          const failedEngine = () => {
            const found = exactEngines.find(
              ({ tableId, engine }) =>
                !(
                  manager.tableEngines.get(tableId) === engine &&
                  (retiredOriginals.has(tableId)
                    ? !tableMap.has(tableId) && !ownedTables.has(tableId)
                    : tableMap.get(tableId) === engine && ownedTables.has(tableId))
                )
            );
            return found === undefined ? 'none' : found.tableId;
          };
          witness(
            'mixed_owner_changed',
            [
              ['server.tournamentEngines', () => server.tournamentEngines === managerMap],
              ['manager.tournamentId', () => manager.tournamentId === capturedTournamentId],
              [
                'manager.tournamentLeaseGeneration',
                () => manager.tournamentLeaseGeneration === capturedLeaseGeneration,
              ],
              [
                'managerMap.get(tournamentId)',
                () => managerMap.get(manager.tournamentId) === manager,
              ],
              [
                'server.tournamentRetirementCustody',
                () => server.tournamentRetirementCustody === retirement,
              ],
              ['server.tournamentOwnedTables', () => server.tournamentOwnedTables === ownedTables],
              [
                'server.unregisterTournamentTableEngine',
                () => server.unregisterTournamentTableEngine === unregister,
              ],
              ['manager.gameServer', () => manager.gameServer === server],
              [
                'manager.captureDrainedF06Originals',
                () => manager.captureDrainedF06Originals === captureMethod,
              ],
              ['manager.captureDrainedF06Originals()', sameOriginals],
              [
                'manager.pendingTableBreakRetirement',
                () => manager.pendingTableBreakRetirement === exactRetirement,
              ],
              [
                'manager.activeStoppedOriginalCustody.size',
                () => manager.activeStoppedOriginalCustody.size === 0,
              ],
              [
                'manager.exactMaps',
                () =>
                  Object.entries(exactMaps).every(
                    ([name, map]) =>
                      manager[name] === map &&
                      map.size === exactMapEntries[name].length &&
                      exactMapEntries[name].every(([key, value]) => map.get(key) === value)
                  ),
              ],
              [
                'manager.exactSets',
                () =>
                  Object.entries(exactSets).every(
                    ([name, set]) => manager[name] === set && set.size === 0
                  ),
              ],
              [
                'manager.exactEngines',
                () =>
                  exactEngines.every(
                    ({ tableId, engine }) =>
                      manager.tableEngines.get(tableId) === engine &&
                      (retiredOriginals.has(tableId)
                        ? !tableMap.has(tableId) && !ownedTables.has(tableId)
                        : tableMap.get(tableId) === engine && ownedTables.has(tableId))
                  ),
              ],
            ],
            // `legacy-engine-checkpoint.mjs` carries a fixed set of
            // observability keys and DROPS every other, so anything that needs
            // to be read travels in `observedDetail` - the same carrier the
            // move-boundary clause above already uses - inside its
            // 512-character and character-class limits.
            () => ({
              failedTable: failedEngine(),
              observed: describe(manager.captureDrainedF06Originals()),
              expected: describe(originals),
              // The lease generation travels here too: it and the tournament
              // id name the custody this checkpoint retires, and the seat move
              // authority revision is deliberately NOT a witness (the live 8825
              // stop-retry loop bumps it every ~5 s without moving custody).
              observedDetail: [
                `tournament=${manager.tournamentId}`,
                `capturedTournament=${capturedTournamentId}`,
                `lease=${describe(manager.tournamentLeaseGeneration)}/${describe(
                  capturedLeaseGeneration
                )}`,
                `drain=${drainWitness()}`,
                `map=${failedMap()}`,
                `set=${failedSet()}`,
              ]
                .join(',')
                .slice(0, 512),
            })
          );
          return vector();
        };
        pending.push({ manager, proposal, exactEngines, vector, current, initial });
      }
      checkRetained = () => {
        for (const capture of pending)
          require(canonical(capture.current()) === capture.initial, 'mixed_local_custody_changed');
      };
      checkMaintenance();
      // Join the originals' own stop queues only. The manager's seat move
      // serial tail is not awaited: on the live 8825 engine the stop-retry loop
      // replaces it every ~5 s, so it never names a fixed piece of work.
      const joined = await Promise.allSettled(
        pending.flatMap((m) => m.exactEngines.flatMap((e) => e.queues))
      );
      require(joined.every((v) => v.status === 'fulfilled'), 'mixed_original_stop_unconfirmed');
      checkMaintenance();
      const ids = pending.flatMap((m) => [...m.exactEngines.map((e) => e.tableId), ...(historicalBankLoss[m.manager.tournamentId]?.generation === m.manager.tournamentLeaseGeneration ? historicalBankLoss[m.manager.tournamentId].pending_arrivals.map((e) => e.table_id) : [])]);
      for (let offset = 0; offset < ids.length; offset += readPageSize) {
        const page = ids.slice(offset, offset + readPageSize);
        const { data, error } = await modules.client.supabase
          .from('engine_presence_parked')
          .select('table_id,engine_instance,parked_at,time_bank_snapshot,disconnect_states')
          .in('table_id', page)
          .limit(page.length + 1);
        checkMaintenance();
        require(!error &&
          Array.isArray(data) &&
          data.length <= page.length, 'mixed_bank_readback_unknown');
        // Freeze the observed row once. A later read must match it; no empty row
        // is invented for a stopped engine whose stop disposed its live bank.
        for (const row of data) {
          require(page.includes(row.table_id) &&
            !bankRows.has(row.table_id), 'mixed_bank_readback_duplicate');
          bankRows.set(row.table_id, detached(row));
        }
        for (const capture of pending) capture.initial = canonical(capture.current());
      }
      for (const capture of pending) {
        const local = detached(capture.current());
        for (const item of local.engines) {
          const bank = item.bank_custody;
          const row = bank.durable_presence;
          const snapshot = row?.time_bank_snapshot;
          const initialized =
            bank.time_bank_metadata.length + Object.keys(bank.parked_time_banks).length > 0;
          // An exact named historical loss is validated by canonical preparation
          // below, before any map retirement. Raw old fields remain unchanged.
          if (bank.historical_loss) {
            require(retained8825 &&
              canonical(bank.historical_loss) === canonical(Object.fromEntries(
                Object.entries(historicalBankLoss[capture.manager.tournamentId]).filter(([key]) => !['occupants', 'pending_arrivals'].includes(key))
              )), 'mixed_historical_loss_scope_changed');
          } else if (initialized) {
            require(record(row) &&
              row.table_id === item.table_id &&
              row.engine_instance === `${options.expectedInstanceId}:parked` &&
              record(snapshot) &&
              snapshot.version === 1 &&
              snapshot.handNumber === bank.hand_number &&
              record(snapshot.players) &&
              record(row.disconnect_states), 'mixed_bank_not_restorable');
            for (const [userId, meta] of bank.time_bank_metadata) {
              const saved = snapshot.players[userId];
              const seat = bank.roster.find(([id]) => id === userId);
              require(seat &&
                validBank(saved) &&
                saved.occupancyId === seat[1] &&
                typeof saved.unlimitedActivations === 'boolean' &&
                Object.entries(meta).every(
                  ([key, value]) => saved[key] === value
                ), 'mixed_bank_not_restorable');
            }
            for (const [userId, saved] of Object.entries(bank.parked_time_banks))
              require(canonical(snapshot.players[userId]) ===
                canonical(saved), 'mixed_bank_not_restorable');
          }
        }
        capture.local = local;
        retainedManagers.push(capture);
      }
      checkMaintenance();
      return retained;
    }

    // Prove, PER TABLE and from rows, that every deferred unresolvable custody
    // is a dead process's permit rather than a hand in the air. Nothing is
    // written until this has answered for all of them.
    //
    // It is the SAME predicate, the SAME three outcomes and the SAME refusal
    // discipline as the boundary proof below it, deliberately and for the same
    // reason: a second, differently-tuned definition of "a hand is in the air"
    // is how a gate ends up disagreeing with itself. Zero fresh incomplete
    // snapshot rows is QUIET. Any fresh row is A HAND IN THE AIR. An error, a
    // non-array body or a page that filled is COULD NOT TELL, and it refuses -
    // never folded into "no rows" (CLAUDE.md 10.86 rules 1-2). There is no
    // flag, option or argument that turns this refusal into permission.
    async function proveUnresolvableCustody(checkAll) {
      if (deferredUnresolvableCustody.size === 0) return;
      const ids = [...deferredUnresolvableCustody.keys()].sort();
      require(ids.length <= maxTables, 'f06_custody_unresolvable_unproven');
      const since = new Date(Date.now() - inflightWindowMs).toISOString();
      for (let offset = 0; offset < ids.length; offset += readPageSize) {
        const page = ids.slice(offset, offset + readPageSize);
        checkAll();
        const { data, error } = await modules.client.supabase
          .from('hand_state_snapshots')
          .select('table_id,hand_number,stage,updated_at')
          .in('table_id', page)
          .eq('is_complete', false)
          .gte('updated_at', since)
          .limit(page.length + 1);
        checkAll();
        // `error` first, every time: `(await res).data` on a failed read is not
        // an empty result, and `undefined || []` reads as good news.
        require(!error && Array.isArray(data) && data.length === 0,
          'f06_custody_unresolvable_unproven');
        for (const id of page) provenUnresolvableCustody.add(id);
      }
      checkAll();
      // The per-table list is the record, but it outgrew its carrier: run
      // 36022429840 deferred 47 tables and the 512-character cut left the
      // first nine, alphabetically, so the kinds behind the other 38 could not
      // be read at all. The counts go FIRST, for the same reason `permitPhase`
      // sits beside `f06=` rather than after the fleet census: what is
      // appended last is what a long record loses. A kind is the label with
      // its counts removed, so `parkedNoRoster:2` and `parkedNoRoster:4` are
      // one kind and `failedBoundary:attempted` stays its own.
      const kindOf = (label) => String(label).replace(/[0-9]+/g, '').replace(/:(?=\+|$)/g, '');
      const kinds = new Map();
      for (const id of ids) {
        const kind = kindOf(deferredUnresolvableCustody.get(id));
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      unresolvableCustody = `tables=${ids.length} ${[...kinds]
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([kind, count]) => `${kind}=${count}`)
        .join(' ')} ${ids
        .map((id) => `${id}:${deferredUnresolvableCustody.get(id)}`)
        .join(' ')}`.slice(0, 512);
    }

    /**
     * Is the restart certificate shut ONLY by permits no process can resolve?
     *
     * The engine's own `readyForRestart()` is the authority and is asked first;
     * this is consulted only when it says no. At that exact point the ONLY
     * thing that can be keeping it shut is the unparked count: `checkMaintenance`
     * has already pinned `phase === 'counting_down'` and `durableConfirmed`, and
     * `insufficient_reserve` has already required `remainingMs >= reserveMs`,
     * which is well past the engine's own minimum. That is the same argument
     * `maintenance_certificate` in engine-release-transaction.sh makes, and this
     * uses the same ALLOW-LIST, never a deny-list: a reason string this guard
     * does not recognise keeps the gate shut, as do `cards_in_air`, every bank
     * durability class, and anything a future engine invents.
     *
     * Three witnesses, all required. The engine's own reason counts must name
     * nothing but an unresolved F06 preparation; every table this guard can see
     * holding such a preparation must be one the rows PROVED quiet above; and
     * the engine must not be counting more blockers than this guard could
     * identify, which is what the count equality says. A blocker the guard
     * cannot put a table id to is COULD NOT TELL, and it refuses.
     */
    const restartHeldOnlyByProvenUnresolvableCustody = () => {
      try {
        const reasons = maintenance.unparkedReasonCounts;
        if (!record(reasons)) return false;
        const names = Object.keys(reasons);
        if (names.length === 0) return false;
        let counted = 0;
        for (const name of names) {
          if (name !== 'f06_preparation_unresolved' && name !== 'f06_preparation_stuck')
            return false;
          const value = reasons[name];
          if (!Number.isSafeInteger(value) || value < 0) return false;
          counted += value;
        }
        if (counted === 0) return false;
        const blockers = [];
        for (const [tableId, engine] of tableMap) {
          if (engine?.hasUnresolvedF06Preparation?.() === true) blockers.push(tableId);
        }
        return (
          blockers.length === counted &&
          blockers.every((tableId) => provenUnresolvableCustody.has(tableId))
        );
      } catch {
        return false;
      }
    };

    // Prove, PER TABLE and from rows, that every deferred boundary generation
    // is abandoned rather than in flight. Nothing is retired and no custody RPC
    // is sent until this has answered for all of them.
    //
    // The predicate is the one the release gate already uses (see
    // `inflightWindowMs`): an INCOMPLETE `hand_state_snapshots` row WRITTEN TO
    // inside the window. Freshness is the discriminator - thousands of stale
    // incomplete rows exist fleet-wide, and gating on their mere existence
    // would refuse every cutover for ever, which is the same forever-block one
    // level up (CLAUDE.md 10.86 rule 4).
    //
    // THREE OUTCOMES. Zero fresh rows is QUIET. Any fresh row is A HAND IN THE
    // AIR. An error, a non-array body or a page that filled is COULD NOT TELL,
    // and it refuses - never folded into "no rows" (10.86 rules 1-2). There is
    // no flag, option or argument that turns this refusal into permission.
    async function proveAbandonedBoundaries(checkAll) {
      if (deferredAbandonedBoundaries.size === 0) return;
      stage = 'mixed_custody';
      progress('mixed_custody');
      const ids = [...deferredAbandonedBoundaries.keys()].sort();
      require(ids.length <= maxTables, 'mixed_abandoned_generation_unproven');
      const since = new Date(Date.now() - inflightWindowMs).toISOString();
      for (let offset = 0; offset < ids.length; offset += readPageSize) {
        const page = ids.slice(offset, offset + readPageSize);
        checkAll();
        const { data, error } = await modules.client.supabase
          .from('hand_state_snapshots')
          .select('table_id,hand_number,stage,updated_at')
          .in('table_id', page)
          .eq('is_complete', false)
          .gte('updated_at', since)
          .limit(page.length + 1);
        checkAll();
        // `error` first, every time: `(await res).data` on a failed read is not
        // an empty result, and `undefined || []` reads as good news.
        require(!error && Array.isArray(data) && data.length === 0,
          'mixed_abandoned_generation_unproven');
      }
      checkAll();
      abandonedBoundaries = `tables=${ids.length} ${ids
        .map((id) => `${id}:${deferredAbandonedBoundaries.get(id).count}`)
        .join(' ')}`.slice(0, 512);
    }

    async function sealAndRetireOriginals(checkAll) {
      stage = 'mixed_custody';
      progress('mixed_custody');
      for (const capture of retainedManagers) {
        // A sealed manager's transfer is already in the rows: no observe, no
        // commit, no readback. Its fresh intent ids stay unused.
        if (capture.sealed === true) continue;
        const { manager, proposal, local } = capture;
        const input = {
          p_transfer_id: proposal.transfer_id,
          p_tournament_id: manager.tournamentId,
          p_origin_generation: manager.tournamentLeaseGeneration,
          p_successor_generation: proposal.successor_generation,
          p_local: local,
          p_expected: null,
        };
        const rpc = async (name, args) => {
          checkAll();
          if (name === 'fn_f06_prepare_mixed_manager_custody' && args.p_expected !== null)
            custodyCommitAttempted = true;
          const response = await modules.client.supabase.rpc(name, args);
          checkAll();
          const engineShape = () => (Array.isArray(local?.engines) ? local.engines : []);
          const allocationBacked = () =>
            engineShape().filter((e) => e.permit === null && typeof e.allocation_epoch === 'string');
          /* ═══ THE DATABASE NAMED IT AND THE GUARD CALLED IT UNKNOWN (2026-09-24) ═══

             Run 36068474418 is the measurement: 62 tables attempted, 62
             completed, all 62 read back and verified inside their own write
             windows - and then `mixed_custody_rpc_unknown`, naming nothing.
             The Supabase edge log for that second holds what this conjunction
             threw away: `POST /rest/v1/rpc/fn_f06_prepare_mixed_manager_custody`
             answered 400 with SQLSTATE P0001. Which of that function's refusals
             fired is written only in its message, and by the time a person
             looked, the database's own log for that second was no longer
             retained. So the single fact that decides the next fix reached
             nobody, and the outcome was `unknown` because the guard made it
             unknown.

             It cannot be anything else. `fn_f06_prepare_mixed_manager_custody`
             has no path that returns `ok` false: it returns a record with `ok`
             true or it raises. So `response.data.ok` can never be the conjunct
             that fails while the call came back cleanly, and the only reachable
             failure here is an error this conjunction declined to read. That is
             10.86 rule 1: "I could not tell" has to say what it does know.

             Observability only. The three collapsed facts - the call did not
             come back, it came back as something that is not a record, it came
             back saying no - are told apart, and the database's own SQLSTATE
             and refusal token travel with them. `reason` is still
             `mixed_custody_rpc_unknown` for every existing parser, no check,
             threshold or outcome moves, and a refusal is still a refusal that
             carries `retryAllowed` false.

             Only a bare upper-case refusal token of the kind every f06 function
             raises is carried verbatim. Any other string becomes its length,
             exactly as `describe` does, so no permit payload, card, credential
             or player identity can reach a log. */
          witness(
            'mixed_custody_rpc_unknown',
            [
              ['rpc.transport', () => !response.error],
              ['rpc.body', () => record(response.data)],
              ['rpc.ok', () => response.data.ok === true],
            ],
            () => ({
              failedField: name,
              failedTable: manager.tournamentId,
              observed: sqlState(response.error?.code),
              observedDetail: [
                `sqlstate=${sqlState(response.error?.code)}`,
                `refusal=${refusalToken(response.error?.message)}`,
                `hint=${refusalToken(response.error?.hint)}`,
                `details=${describe(response.error?.details)}`,
                `body=${describe(response.data)}`,
                `ok=${describe(response.data?.ok)}`,
                `commit=${args.p_expected === null ? 'no' : 'yes'}`,
                `tournament=${
                  uuid(args.p_tournament_id) ? args.p_tournament_id : describe(args.p_tournament_id)
                }`,
                // From #5218: the physical map this manager refused on. Kept
                // after the database's own answer above, so a truncation at the
                // carrier limit drops the shape and never the SQLSTATE.
                `engines=${engineShape().length}`,
                `permits=${engineShape().filter((e) => e.permit !== null).length}`,
                `allocationBacked=${allocationBacked().length}`,
                `nullLifecycle=${engineShape().filter((e) => e.lifecycle === null).length}`,
                `backed=${allocationBacked()
                  .slice(0, 12)
                  .map(
                    (e) =>
                      `${String(e.table_id).slice(0, 8)}:${String(e.allocation_epoch).slice(0, 8)}:${
                        e.lifecycle === null ? 'null' : e.lifecycle
                      }:hand=${e.bank_custody?.hand_number}:seats=${e.bank_custody?.roster?.length}`
                  )
                  .join('/')}`,
              ]
                .join(',')
                .slice(0, 512),
            })
          );
          return response.data;
        };
        const observation = await rpc('fn_f06_prepare_mixed_manager_custody', input);
        const proof = observation.canonical;
        require(record(proof) &&
          Array.isArray(proof.pending_original_tables) &&
          proof.pending_original_tables.length === 0 &&
          Array.isArray(proof.original_evidence) &&
          canonical(observation.local) === canonical(local) &&
          observation.transfer_id === proposal.transfer_id &&
          observation.tournament_id === manager.tournamentId &&
          observation.origin_generation === manager.tournamentLeaseGeneration &&
          observation.successor_generation ===
            proposal.successor_generation, 'mixed_original_receipt_missing');
        const loss = historicalBankLoss[manager.tournamentId];
        if (local.engines.some((e) => e.bank_custody.historical_loss)) {
          require(loss?.generation === manager.tournamentLeaseGeneration &&
            proof.historical_loss?.kind === 'historical_loss_normal_session_v1' &&
            proof.historical_loss.original_receipt_id === loss.receipt_id &&
            Array.isArray(proof.historical_loss.plans) &&
            proof.historical_loss.plans.length === local.engines.length, 'mixed_historical_loss_unproven');
          require(Array.isArray(proof.historical_loss.pending_arrivals) &&
            proof.historical_loss.pending_arrivals.length === loss.pending_arrivals.length, 'mixed_historical_pending_unproven');
          for (const original of loss.pending_arrivals) {
            const entries = proof.historical_loss.pending_arrivals.filter((p) => p.source?.table_id === original.table_id);
            require(entries.length === 1 && entries[0].proof?.historical_loss?.original_kind === 'pending_arrival_historical_loss_v1' &&
              canonical(entries[0].proof.historical_loss.observations?.[0]?.original) === canonical(original), 'mixed_historical_pending_unproven');
            const allowance = entries[0].proof.historical_loss.observations[0].allowance;
            require(allowance.user_id === original.user_id && allowance.is_lifetime === true &&
              allowance.is_vip === true && allowance.unlimited_activations === true && allowance.purchased_seconds === 0 &&
              allowance.extra_seconds === 0 && allowance.vip_seconds_remaining === null, 'mixed_historical_pending_unproven');
          }
          const seen = new Set();
          for (const plan of proof.historical_loss.plans) {
            require(local.engines.some((e) => e.table_id === plan.table_id) && !seen.has(plan.table_id), 'mixed_historical_loss_unproven');
            seen.add(plan.table_id);
            const originals = loss.occupants.filter((e) => e.table_id === plan.table_id);
            require(plan.disposition?.old_final_balance === 'unknown' &&
              plan.disposition.old_debit_outcomes === 'retained_not_replayed' &&
              plan.disposition.initialization === 'ordinary_lifetime_session' &&
              Array.isArray(plan.disposition.observations) &&
              plan.disposition.observations.length === originals.length &&
              record(plan.normal_session) && Object.keys(plan.normal_session).length === originals.length,
              'mixed_historical_loss_unproven');
            for (const original of originals) {
              const observations = plan.disposition.observations.filter((o) => canonical(o.original) === canonical(original));
              require(observations.length === 1, 'mixed_historical_loss_unproven');
              const allowance = observations[0].allowance;
              require(allowance.user_id === original.user_id && allowance.is_vip === true &&
                allowance.is_lifetime === true && allowance.unlimited_activations === true &&
                allowance.vip_seconds_remaining === null && allowance.purchased_seconds === 0 && allowance.extra_seconds === 0 &&
                canonical(plan.normal_session[original.user_id]) === canonical({occupancyId: original.occupancy_id,
                  remainingSeconds: 40, usesRemaining: 2, initialSeconds: 40, baseSeconds: 40, dbConsumedSeconds: 0,
                  unlimitedActivations: true}), 'mixed_historical_loss_allowance_unproven');
            }
          }
        }
        // 8825 retains the original allocator epoch after an accepted hand clears
        // its local permit. Resolve only through the exact original custody rows,
        // never by copying a current table lifecycle into the stopped engine.
        const allocationBacked = capture.exactEngines.filter(
          (e) => e.permit === null && e.allocationEpoch !== null
        );
        require(Array.isArray(proof.engine_lifecycles) &&
          proof.engine_lifecycles.length ===
            allocationBacked.length, 'mixed_original_lifecycle_evidence_missing');
        for (const original of allocationBacked) {
          const matches = proof.engine_lifecycles.filter((e) => e.table_id === original.tableId);
          require(matches.length === 1, 'mixed_original_lifecycle_evidence_missing');
          const witness = matches[0];
          /* AN EPOCH THAT NEVER RESERVED A HAND IS WITNESSED BY ITS ABSENCE
             (2026-09-24). An engine holds one allocator epoch for its life and
             every hand it deals reserves a permit under it, so an epoch with
             no permit row is an engine that dealt nothing in this generation -
             a table admitted and left waiting for players. Run 36068474418
             refused the whole transfer for seven of them. The database now
             witnesses that case under its locks (migration
             20260924225647): no permit under the epoch, no reserved hand on
             the table, the table's own lifecycle, `permits: []` and
             `witness: 'never_reserved'`. This holds the receipt to exactly
             that shape, and to the shape it always had for an epoch that did
             reserve; a receipt saying neither refuses as before. */
          const neverReserved =
            witness.witness === 'never_reserved' &&
            Array.isArray(witness.permits) &&
            witness.permits.length === 0 &&
            original.permit === null &&
            original.lifecycle === null;
          require(witness.allocation_epoch === original.allocationEpoch &&
            typeof witness.lifecycle === 'string' &&
            /^[1-9][0-9]{0,18}$/.test(witness.lifecycle) &&
            (original.lifecycle === null || original.lifecycle === witness.lifecycle) &&
            Array.isArray(witness.permits) &&
            (neverReserved ||
              (witness.witness === 'permits' &&
                witness.permits.length > 0 &&
                new Set(witness.permits.map((p) => p.permit_id)).size === witness.permits.length &&
                witness.permits.every(
                  (p) =>
                    uuid(p.permit_id) &&
                    p.tournament_id === manager.tournamentId &&
                    p.generation === manager.tournamentLeaseGeneration &&
                    p.table_id === original.tableId &&
                    p.custody_id === original.allocationEpoch &&
                    Number.isSafeInteger(p.lifecycle) &&
                    String(p.lifecycle) === witness.lifecycle &&
                    ['accepted', 'never_started', 'aborted_unsettled'].includes(p.state)
                ))), 'mixed_original_lifecycle_evidence_invalid');
          original.lifecycle = witness.lifecycle;
          local.engines.find((e) => e.table_id === original.tableId).lifecycle = witness.lifecycle;
        }
        // This updates only the captured receipt DTO with validated historical
        // evidence; original engine fields and their captured references never change.
        capture.initial = canonical(capture.current());
        require(canonical(capture.current()) === canonical(local), 'mixed_local_custody_changed');
        checkAll();
        require(proof.original_evidence.length ===
          local.engines.filter((e) => e.permit !== null)
            .length, 'mixed_original_receipt_set_changed');
        let originalDispositions = 0;
        for (const item of local.engines.filter((e) => e.permit !== null)) {
          const found = proof.original_evidence.filter(
            (e) => canonical(e.binding) === canonical(item.permit.binding)
          );
          require(found.length === 1 &&
            record(found[0].evidence), 'mixed_original_receipt_missing');
          const { permit, evidence } = found[0];
          // `unknown`, `reserved` and `terminated` are the engine's own
          // `hasUnresolvedF06Preparation` triple - a hand that was prepared and
          // never started. `attempted` is the fourth disposition this checkpoint
          // can meet and the only one that reserved a terminal boundary integer:
          // the hand DID start and was cut off, which is exactly the state the
          // retained 8825 originals are in. It is included here, not to widen
          // what may be retired, but so that the `aborted_unsettled` receipt is
          // DEMANDED of it: leaving it out let a started, unsettled hand reach
          // retirement carrying no proof at all, which is the weaker position.
          if (['unknown', 'reserved', 'terminated', 'attempted'].includes(item.permit.phase)) {
            require(permit.state === 'aborted_unsettled' &&
              uuid(permit.evidence_id) &&
              evidence.hand?.receipt_id === permit.evidence_id &&
              evidence.hand?.permit_id === permit.permit_id &&
              evidence.receipt?.receipt_id === permit.evidence_id &&
              evidence.receipt?.outcome === 'aborted_unsettled' &&
              evidence.receipt?.expected?.kind === 'retained_mtt_interruption_v1' &&
              evidence.receipt.expected.physical?.manager_id === local.manager_id &&
              evidence.receipt.expected.physical?.engine_id === item.engine_id &&
              evidence.receipt.expected.physical?.container_id ===
                options.custodyIntent.container, 'mixed_original_disposition_unproven');
            originalDispositions++;
          }
        }
        require(originalDispositions === 1, 'mixed_original_disposition_set_changed');
        capture.commit = { rpc, input, proof };
      }
      /* ═══ EVERY MANAGER IS OBSERVED BEFORE ANY IS COMMITTED (2026-09-24) ═══

         The commit call (`p_expected` set) INSERTS an immutable
         `f06_manager_custody_transfers` row carrying this run's
         `release_checkpoint` (run id, ownership token, break times). Until
         today each manager was observed and committed in turn, so a refusal
         on the SECOND manager's observation - which the rows say is exactly
         what the next attempt will meet: `F06_RETIRED_CANONICAL_CHANGED:
         registrations` on 615783bf, a bust recorded after its origin was
         attested - would have left the FIRST manager's row behind, and every
         later attempt would then refuse that manager as
         `F06_MIXED_TRANSFER_CHANGED` against a row nothing can delete. The
         wedge one level up (CLAUDE.md 10.86 rule 4), made by this guard.

         So the two calls are two phases. Every manager's observation, and
         every check this guard makes of it, completes before the first commit
         is sent; a refusal anywhere in the first phase commits nothing. The
         database still holds each commit to its own observation
         (`F06_MIXED_CANONICAL_CHANGED`), so nothing that could move between
         the phases is admitted by the split. */
      for (const capture of retainedManagers) {
        if (capture.sealed === true) continue;
        const { manager, proposal, local } = capture;
        const { rpc, input, proof } = capture.commit;
        const committed = await rpc('fn_f06_prepare_mixed_manager_custody', {
          ...input,
          p_expected: proof,
        });
        require(record(committed.receipt) &&
          committed.receipt.transfer_id === proposal.transfer_id &&
          committed.receipt.tournament_id === manager.tournamentId &&
          committed.receipt.origin_generation === manager.tournamentLeaseGeneration &&
          committed.receipt.successor_generation === proposal.successor_generation &&
          canonical(committed.receipt.local_proof) === canonical(local) &&
          canonical(committed.receipt.canonical_proof) ===
            canonical(proof), 'mixed_custody_receipt_mismatch');
        const readback = await rpc('fn_f06_find_mixed_manager_custody', {
          p_tournament_id: manager.tournamentId,
        });
        require(canonical(readback.receipt) ===
          canonical(committed.receipt), 'mixed_custody_readback_mismatch');
        capture.receipt = detached(committed.receipt);
      }
      // Both continuing owners must exist before retiring either event. All CAS
      // calls are synchronous and all captured local objects remain untouched.
      checkAll();
      for (const capture of retainedManagers) {
        if (capture.sealed === true) {
          // The seal was proved from rows at capture. What is retired below is
          // only what that row named and this process still holds, and only
          // while the same manager still owns the same generation.
          require(server.tournamentEngines.get(capture.manager.tournamentId) === capture.manager &&
            capture.manager.tournamentLeaseGeneration ===
              capture.capturedLeaseGeneration, 'mixed_sealed_owner_changed');
        } else require(record(capture.receipt), 'mixed_custody_receipt_missing');
        for (const { tableId, engine } of capture.exactEngines) {
          checkAll();
          require(server.unregisterTournamentTableEngine(tableId, engine) ===
            true, 'mixed_original_retirement_cas_refused');
          retiredOriginals.add(tableId);
          checkAll();
        }
      }
    }

    /* ═══ A BANK REFUSAL NAMES ITS TABLE, AND THE FLEET THAT HOLDS THE SAME SHAPE (2026-09-22) ═══

       Observability only. Never read by a decision; evaluated only on a
       refusal path that is already throwing, through `noteRefusal`, which
       keeps the FIRST refusal's detail and swallows any error of its own. No
       condition, code, order or threshold below moves.

       Production run 35620115786 is the only 8825 checkpoint so far whose
       preflight got past the mixed-custody capture and the drain witnesses.
       It refused `bank_metadata_without_bank` at 15:43:34Z on 2026-09-21 and
       named nothing: `captureEngine` refused through the process-wide
       `require`, which carries no detail, so nobody could say which of ~150
       tables held it. The 8825 source has two ways to produce it:

       - a DEPARTED player's metadata. 8825 deletes `timeBankMeta` in exactly
         one place, the cash branch of `adoptSeatRoster`
         (ServerTableEngineBase.ts:4283). A voluntary cashout (:3679), a seat
         move (:4061), a busted release (:7508), a sit-out eviction (:7691)
         and `tearDownDepartedSeats` (ServerTableEngineSettlement.ts:3738)
         remove the bank and the seat and keep the metadata; the tournament
         branch of `adoptSeatRoster` deletes nothing, and a tournament bust
         removes no bank at all (ServerTableEngineDealing.ts:448 is cash-only).
       - a STOPPED engine still in the fleet map. 8825 `stop()` disposes every
         live bank (`timeBankEngine.disposeAll()`, :3579) and keeps
         `seatedPlayers` and `timeBankMeta`. A tournament manager whose
         teardown throws "retained an unresolved seat-move UUID" retries every
         few seconds and never reaches `unregisterTournamentTableEngine`, so
         its stopped engines stay registered.

       They need different dispositions and neither may be waved through (see
       "A BANK THE ENGINE NO LONGER HOLDS IS NOT CUSTODY" below). A refusal
       here names its table and a player-free shape of it, plus a
       census of every engine the capture walks, by the same shape, so ONE
       refused attempt is enough to design the disposition. Sizes, booleans,
       the lease scope and tournament ids only: no player id, bank value or
       seat leaves the guard, and the string stays inside the publisher's
       512-character carrier and its character class. */
    const sizeOf = (value) => (value instanceof Set || value instanceof Map ? value.size : -1);
    const bankShape = (tableId, engine) => {
      const seats = new Set(
        Array.isArray(engine?.seatedPlayers) ? engine.seatedPlayers.map((seat) => seat?.user_id) : []
      );
      const banks = engine?.timeBankEngine?.playerBanks;
      const bankOf = (userId) => banks instanceof Map && banks.has(`${tableId}:${userId}`);
      const meta = engine?.timeBankMeta instanceof Map ? [...engine.timeBankMeta.keys()] : [];
      const bankUsers = banks instanceof Map ? [...banks.values()].map((bank) => bank?.playerId) : [];
      return {
        stopped: engine?.running === false,
        seats: seats.size,
        banks: banks instanceof Map ? banks.size : -1,
        meta: meta.length,
        metaUnseated: meta.filter((userId) => !seats.has(userId)).length,
        metaSeatedWithoutBank: meta.filter((userId) => seats.has(userId) && !bankOf(userId)).length,
        bankUnseated: bankUsers.filter((userId) => !seats.has(userId)).length,
      };
    };
    const fleetBankCensus = () => {
      try {
        let walked = 0;
        let stopped = 0;
        let stoppedSeatedMeta = 0;
        let liveSeatedMeta = 0;
        let departedMeta = 0;
        let orphanBank = 0;
        let permits = 0;
        let boundaries = 0;
        const stoppedEvents = new Set();
        for (const [tableId, engine] of tableMap) {
          // The same two exclusions the capture loop makes, and no others.
          if (retainedEngines.has(engine) || neverStarted(tableId, engine)) continue;
          walked++;
          const shape = bankShape(tableId, engine);
          if (shape.stopped) stopped++;
          if (shape.metaSeatedWithoutBank > 0) {
            if (shape.stopped) {
              stoppedSeatedMeta++;
              const event = engine?.engineLeaseTournamentId;
              stoppedEvents.add(uuid(event) ? event.slice(0, 8) : 'none');
            } else {
              liveSeatedMeta++;
            }
          }
          if (shape.metaUnseated > 0) departedMeta++;
          if (shape.bankUnseated > 0) orphanBank++;
          if (engine?.f06CurrentPermit != null || engine?.f06RecoveryInFlight === true) permits++;
          if (sizeOf(engine?.terminalBoundaryPendingGenerations) !== 0) boundaries++;
        }
        return [
          `fleet=${walked}`,
          `fleetStopped=${stopped}`,
          `fleetStoppedSeatedMeta=${stoppedSeatedMeta}`,
          `fleetLiveSeatedMeta=${liveSeatedMeta}`,
          `fleetDepartedMeta=${departedMeta}`,
          `fleetOrphanBank=${orphanBank}`,
          `fleetF06=${permits}`,
          `fleetBoundary=${boundaries}`,
          `stoppedEvents=${[...stoppedEvents].sort().slice(0, 12).join('/') || 'none'}`,
        ];
      } catch {
        return ['fleet=unreadable'];
      }
    };
    // Observability only, by the same rule as `permitPhase` on the mixed-original
    // boundary field above: the F06 refusal in this capture turns on WHICH phase
    // the retained permit is in, so a refusal here is unreadable without it.
    // `attempted` is a hand that may have started; `terminated` and
    // `number_refused` provably never dealt; `new`, `reserved` and `unknown` are
    // a preparation whose fate the database, not this guard, decides. The boolean
    // pair below says only that a permit exists, which is every one of those six.
    // Its own try/catch keeps a throwing accessor costing this ONE token instead
    // of blanking the whole record through `noteRefusal`, and `describe` holds it
    // to the same identifier-only character class as every other field here.
    const permitPhaseOf = (engine) => {
      try {
        const permit = engine?.f06CurrentPermit;
        if (permit === null || permit === undefined) return 'none';
        return describe(permit.recoveryState?.());
      } catch {
        return 'unreadable';
      }
    };
    // Observability only, by the same rule as `permitPhase` above.
    // `parked_bank_invalid` is a conjunction of three separate facts about a
    // restored time bank - the key is a user id, the bank is restorable, and it
    // belongs to a seat this engine still holds - and a refusal that does not
    // say which of them failed is unreadable. This names the FIRST parked entry
    // that fails and the sub-condition that failed it, in the exact original
    // left-to-right order, and reads nothing the original conjunction does not.
    // Its own try/catch keeps a throwing accessor costing this ONE token
    // instead of blanking the whole record through `noteRefusal`.
    const parkedFaultOf = (engine) => {
      try {
        const parked = engine?.parkedTimeBanks;
        if (!record(parked)) return 'none';
        const seats = new Map(
          (Array.isArray(engine?.seatedPlayers) ? engine.seatedPlayers : [])
            .filter((seat) => record(seat))
            .map((seat) => [seat.user_id, seat])
        );
        for (const [userId, bank] of Object.entries(parked)) {
          if (!uuid(userId)) return 'user_not_uuid';
          if (!validBank(bank)) return 'bank_not_restorable';
          if (!seats.has(userId)) return 'unseated';
          if (seats.get(userId).occupancy_id !== bank.occupancyId) return 'occupancy_mismatch';
        }
        return 'none';
      } catch {
        return 'unreadable';
      }
    };
    const engineRefusalDetail = (tableId, engine, code) => {
      const shape = bankShape(tableId, engine);
      const tournament = engine?.engineLeaseTournamentId;
      const parked = engine?.parkedTimeBanks;
      return {
        failedCheck: `captureEngine.${code}`,
        failedTable: uuid(tableId) ? tableId : describe(tableId),
        observedDetail: [
          `stopped=${shape.stopped}`,
          `terminal=${engine?.terminal === true}`,
          `scope=${describe(engine?.engineLeaseScope)}`,
          `tournament=${uuid(tournament) ? tournament : 'none'}`,
          `seats=${shape.seats}`,
          `banks=${shape.banks}`,
          `meta=${shape.meta}`,
          `metaUnseated=${shape.metaUnseated}`,
          `metaSeatedWithoutBank=${shape.metaSeatedWithoutBank}`,
          `bankUnseated=${shape.bankUnseated}`,
          `parked=${record(parked) ? Object.keys(parked).length : -1}`,
          // Which of the three facts `parked_bank_invalid` turns on failed.
          // Beside `parked=`, never appended after the fleet census, for the
          // same reason `permitPhase` is: this list is cut at 512 characters.
          `parkedFault=${parkedFaultOf(engine)}`,
          // The other per-engine refusals in this capture, by the same rule:
          // an F06 permit or recovery, work in flight, a boundary generation,
          // and the accounting registry.
          `f06=${engine?.f06CurrentPermit != null}/${engine?.f06RecoveryInFlight === true}`,
          // Placed here, beside `f06=`, and never appended after the fleet census:
          // this list is truncated to 512 characters, so a token added at the end
          // is the first thing a long refusal drops.
          `permitPhase=${permitPhaseOf(engine)}`,
          `settling=${sizeOf(engine?.settlementInFlight)}`,
          `postTasks=${engine?.postHandTasksPromise != null}`,
          `moves=${sizeOf(engine?.tournamentMoveOperations)}`,
          `actionLock=${engine?.actionLock === true}`,
          `boundary=${sizeOf(engine?.terminalBoundaryPendingGenerations)}/${engine?.terminalBoundaryPersistenceFailed === true}`,
          `accounting=${sizeOf(engine?.timeBankAccountingPending)}`,
          ...fleetBankCensus(),
        ]
          .join(',')
          .slice(0, 512),
      };
    };
    /* ═══ A PERMIT ON AN ENGINE THAT WILL NEVER RUN AGAIN (2026-09-23) ═══

       An F06 permit is PROCESS-LOCAL. It is resolved by the engine that holds
       it - settlement finishes an `attempted` one, `cancelPreparedHand` or
       `drainNeverStarted` finish the others - and by nothing else. An engine
       that is STOPPED and TERMINAL has run its teardown and will never deal
       again, so the permit it still holds cannot be resolved by waiting. The
       only thing that clears it is replacing the process.

       Until today this capture refused ANY retained permit, on any engine,
       with no bound. That is the same fail-closed shape, on the same shared
       resource, that `MaintenanceBreak` bounded on 2026-09-21 after one such
       permit held the restart certificate shut for seventy consecutive breaks
       (`F06_UNRESOLVED_GATE_MS`, and the comment above it), and that
       `engine-release-transaction.sh` bounded for the health gate in #5003.
       Here it held the checkpoint shut instead: the refusal prevented the
       replacement that is the permit's only resolution, so the fix for the
       wedge sat behind the wedge. Measured on run 35897820986:
       `captureEngine.f06_custody_not_drained`, `retryAllowed:false`,
       `stopped=true terminal=true banks=0 permitPhase=attempted`.

       THIS IS NOT A RELAXATION OF "A HAND MIGHT BE IN THE AIR". A hand in the
       air still refuses, from rows, in `proveUnresolvableCustody`. What is
       bounded is only the case where waiting cannot help.

       The conjunction here is deliberately NARROW and deliberately does NOT
       repeat the conditions every captured engine must satisfy a few lines
       below anyway - `stopped_engine_not_released` (terminal teardown joined,
       no dealing loop, no read continuations, process ownership released, no
       hand controller), `engine_work_not_drained` (no settlement, no post-hand
       tasks, no move operations, no pending or failed boundary) and
       `native_accounting_not_drained` (the native debit registry drained and
       unconfirmed false). A table that fails one of those still refuses the
       whole checkpoint, exactly as before; deferring it here changes nothing
       about that. What IS asserted here is what those checks do not cover: a
       permit is present, no recovery is in flight that could still resolve it,
       the engine is stopped and terminal, and it holds no live time bank. */
    const deadEngineCustody = (tableId, engine) => {
      try {
        if (
          engine.f06CurrentPermit === null ||
          engine.f06RecoveryInFlight !== false ||
          engine.running !== false ||
          engine.terminal !== true ||
          engine.handController !== null ||
          !(engine.timeBankEngine?.playerBanks instanceof Map) ||
          engine.timeBankEngine.playerBanks.size !== 0
        )
          return false;
        deferredUnresolvableCustody.set(tableId, permitPhaseOf(engine));
        return true;
      } catch {
        // Unreadable is never "dead". It keeps the original refusal.
        return false;
      }
    };
    /* ═══ THE SAME THREE OUTCOMES, IN THE OTHER CAPTURE (2026-09-23) ═══

       `physical()` has carried a three-way rule on
       `terminalBoundaryPendingGenerations` since #5020 and #5021 merged, and
       the comment above it sets out the whole argument. THIS capture, which
       walks every table `physical()` does not, still demanded a flat zero. So
       the release cleared the F06 permit refusal and stopped one require
       later, on the same table, for the same reason: run 35927313976 refused
       `captureEngine.engine_work_not_drained` on 9e432569 with
       `boundary=1/false, permitPhase=attempted` - which is exactly the shape
       `physical()` ADMITS. A fix that leaves the same trap one level up has
       not landed (CLAUDE.md 10.86 rule 4).

       The three outcomes, unchanged in substance from the other path:

         an `attempted` permit on a dead engine -> ONE is allowed.
           `beginTerminalBoundaryPersistence` has one call site and on an
           engine holding a permit it runs inside `F06HandPermit.start`, one
           line after the phase becomes `attempted`. The integer IS that
           started, cut-off hand.
         no permit at all on a dead engine      -> DEFERRED, never waved
           through. With no permit there is no phase to reason from and no
           outstanding hand, so nothing downstream of HAND_COMPLETE can ever
           resolve the generation; `proveUnresolvableCustody` refuses unless
           the rows prove the felt quiet, BEFORE anything is written.
         anything else                          -> 0, exactly as before. A
           permit in another phase is an engine we do not understand, and a
           LIVE engine keeps the flat zero it has always had.

       "Dead" here is `deadEngineCustody`'s conjunction and nothing wider, and
       the shape is proved before the count: a set holding anything but
       positive integers, or more of them than a table can hold, refuses
       without a row read. */
    const boundaryGenerationsAllowed = (tableId, engine) => {
      try {
        const collection = engine.terminalBoundaryPendingGenerations;
        if (!(collection instanceof Set) || collection.size === 0) return 0;
        const generations = [...collection];
        if (
          collection.size > maxEntriesPerTable ||
          !generations.every((value) => Number.isSafeInteger(value) && value > 0) ||
          engine.terminalBoundaryPersistenceFailed !== false ||
          engine.running !== false ||
          engine.terminal !== true ||
          engine.handController !== null ||
          engine.f06RecoveryInFlight !== false ||
          !(engine.timeBankEngine?.playerBanks instanceof Map) ||
          engine.timeBankEngine.playerBanks.size !== 0
        )
          return 0;
        const phase = permitPhaseOf(engine);
        if (phase === 'attempted') return 1;
        if (phase !== 'none') return 0;
        deferredUnresolvableCustody.set(tableId, `boundary${collection.size}`);
        return collection.size;
      } catch {
        // Unreadable is never an allowance. It keeps the original zero.
        return 0;
      }
    };
    /* ═══ A STICKY "DID NOT SUCCEED" ON A PROCESS THAT IS ALREADY DEAD ═══
       (2026-09-24)

       #5155 gave this capture the same three boundary outcomes `physical()`
       has carried since #5020 and #5021. The first release on that SHA, run
       35956154940, got one require further than any release since
       2026-09-18 and then stopped on the LAST conjunct of the same proof, on
       table 6557ebd8:

         captureEngine.engine_work_not_drained
         stopped=true terminal=true boundary=0/true permitPhase=attempted

       `boundary=0/true` is an EMPTY pending set and a set
       `terminalBoundaryPersistenceFailed`. Nothing is outstanding. What
       refuses is a flag left by a boundary that has already resolved, and
       resolved badly. That flag is cleared in exactly one place,
       `beginTerminalBoundaryPersistence` (ServerTableEngineBase), which runs
       immediately before `HandController.start`. A STOPPED, TERMINAL engine
       will never start another hand, so on this engine the flag is true for
       ever and no amount of waiting moves it. The only thing that clears it
       is replacing the process, which is exactly what it was blocking:
       CLAUDE.md 10.86, the fix for the wedge sitting behind the wedge.

       THIS IS NOT "A FAILED PERSISTENCE IS NOW AN ALLOWANCE". It is still
       never an allowance for a PENDING generation: `boundaryGenerationsAllowed`
       keeps `terminalBoundaryPersistenceFailed !== false -> 0`, so a dead
       engine still carrying an unresolved generation refuses one conjunct
       earlier, without a row read, exactly as before. A LIVE engine keeps the
       flat `=== false` in every phase. `physical()` is untouched: it walks
       only the mixed-custody originals, and its deferral is about an
       abandoned generation that never asserted "did not succeed" at all.

       What is bounded here is only the case waiting cannot answer, and it is
       not answered from memory. ServerTableEngineBase says so itself, above
       `abandonTerminalBoundaryPersistence`: "Whether that hand settled is
       answered from the database (`hand_state_snapshots`, `f06_hand_permits`),
       never from the memory of a process that is already dead." So the table
       is DEFERRED into the same `deferredUnresolvableCustody` map as the two
       cases above, and `proveUnresolvableCustody` refuses the whole checkpoint
       unless the rows prove that table quiet BEFORE anything is written. A
       hand in the air still refuses, from rows. */
    const deadBoundaryFailureDeferred = (tableId, engine) => {
      try {
        if (
          engine.terminalBoundaryPersistenceFailed !== true ||
          !(engine.terminalBoundaryPendingGenerations instanceof Set) ||
          engine.terminalBoundaryPendingGenerations.size !== 0 ||
          engine.running !== false ||
          engine.terminal !== true ||
          engine.handController !== null ||
          engine.f06RecoveryInFlight !== false ||
          engine.postHandTasksPromise !== null ||
          !(engine.settlementInFlight instanceof Set) ||
          engine.settlementInFlight.size !== 0 ||
          !(engine.timeBankEngine?.playerBanks instanceof Map) ||
          engine.timeBankEngine.playerBanks.size !== 0
        )
          return false;
        const phase = permitPhaseOf(engine);
        if (phase !== 'attempted' && phase !== 'none') return false;
        deferredUnresolvableCustody.set(tableId, `failedBoundary:${phase}`);
        return true;
      } catch {
        // Unreadable is never "dead". It keeps the original refusal.
        return false;
      }
    };
    /* ═══ A RESTORED BANK NO ROSTER WILL EVER CLAIM (2026-09-24) ═══

       Run 36000655625 is the measurement: `captureEngine.parked_bank_invalid`
       on b027e4cf with `stopped=true terminal=true scope=tournament seats=0
       banks=0 meta=0 parked=2 permitPhase=none boundary=0/false`. Two restored
       time banks and an empty roster.

       `parkedTimeBanks` is written in exactly two places in 8825.
       `readParkedTimeBanks` fills it from `engine_presence_parked` once, inside
       `start()` (ServerTableEngineBase.ts:5548), and `applyParkedTimeBanks`
       empties it (:4311) at the end of `adoptSeatRoster` - which has ONE call
       site, the wait-for-players loop at :3217. A STOPPED, TERMINAL engine has
       run its teardown and will never enter that loop again, so on this engine
       the map is non-empty for ever and no amount of waiting moves it. The only
       thing that clears it is replacing the process, which is exactly what this
       refusal prevented: CLAUDE.md 10.86, the fix for the wedge sitting behind
       the wedge, and the same shape as the sticky boundary flag above it.

       THIS IS NOT "A RESTORED BANK NO LONGER HAS TO BELONG TO A SEAT". The two
       shape conjuncts of the same require are untouched and are still proved
       first, on this engine as on every other: a key that is not a user id, or
       a bank that is not restorable, refuses exactly as before. A LIVE engine
       keeps the flat occupancy equality in every phase - and a live engine that
       has adopted a roster has an empty map anyway, because adopting it is what
       empties it. What is bounded is only the case waiting cannot answer.

       NOTHING IS STRANDED BY ADMITTING IT, AND NOTHING IS INVENTED. 8825's own
       `captureParkedTimeBanks` starts from `{ ...this.parkedTimeBanks }`
       (:5528) and this engine seats nobody, so the row the checkpoint writes
       for this table is the row it read, at the same `handNumber` - which is
       what `loadTimeBanksFromPark` matches on (snapshots.ts:305-319). The
       successor reads the same banks back and binds them to the same
       occupancies when those seats are adopted. Refusing here does not protect
       those two banks from anything; it only keeps the engine that would
       restore them from ever starting.

       The conjunction is NARROW and deliberately does not repeat what every
       captured engine must satisfy a few lines below anyway -
       `stopped_engine_not_released` (terminal teardown joined, process
       ownership released, no hand controller) and `engine_work_not_drained`
       (no settlement, no post-hand tasks, no move operations, no pending or
       failed boundary). What IS asserted is what those do not cover: the
       roster was never adopted, and this engine holds nothing live that could
       still claim the bank - no seat, no bank, no bank metadata, and no
       recovery in flight. And a deferral is not a waiver: the table goes into
       the same `deferredUnresolvableCustody` map as the three cases above, and
       `proveUnresolvableCustody` refuses the whole checkpoint unless the rows
       prove that table quiet BEFORE anything is written. A hand in the air
       still refuses, from rows. */
    const deadParkedBanksDeferred = (tableId, engine) => {
      try {
        if (
          engine.running !== false ||
          engine.terminal !== true ||
          engine.f06RecoveryInFlight !== false ||
          !Array.isArray(engine.seatedPlayers) ||
          engine.seatedPlayers.length !== 0 ||
          !(engine.timeBankEngine?.playerBanks instanceof Map) ||
          engine.timeBankEngine.playerBanks.size !== 0 ||
          !(engine.timeBankMeta instanceof Map) ||
          engine.timeBankMeta.size !== 0 ||
          !record(engine.parkedTimeBanks) ||
          Object.keys(engine.parkedTimeBanks).length === 0 ||
          Object.keys(engine.parkedTimeBanks).length > maxEntriesPerTable
        )
          return false;
        deferredUnresolvableCustody.set(
          tableId,
          `parkedNoRoster:${Object.keys(engine.parkedTimeBanks).length}`
        );
        return true;
      } catch {
        // Unreadable is never "dead". It keeps the original refusal.
        return false;
      }
    };
    const captureEngine = (tableId, engine) => {
      // The same condition, the same code and the same order as the
      // process-wide `require` it shadows at every call below; this one only
      // notes which table refused, and its shape, before refusing (see the
      // observability note above). No outcome can move.
      const require = (condition, code) => {
        if (condition) return;
        noteRefusal(() => engineRefusalDetail(tableId, engine, code));
        noteCensus(tableId, code);
        refuse(code);
      };
      require(uuid(tableId) &&
        engine instanceof modules.base.ServerTableEngineBase &&
        engine.tableId === tableId, 'engine_identity_mismatch');
      if (trackedAccounting) {
        // These fields belong to the exact native 758/a0 owner. Unknown or retained
        // work is not an empty boundary, even when the map entry is stopped.
        require(engine.timeBankAccountingPending instanceof Set &&
          engine.timeBankAccountingPending.size === 0 &&
          engine.timeBankAccountingUnconfirmed === false &&
          Number.isSafeInteger(engine.maintenanceCheckpointGeneration) &&
          engine.maintenanceCheckpointGeneration >= 0, 'native_accounting_not_drained');
        require(engine.f06RecoveryInFlight === false &&
          (engine.f06CurrentPermit === null ||
            deadEngineCustody(tableId, engine)), 'f06_custody_not_drained');
      }
      const stopped = engine.running === false;
      const methodNames = [
        'persistPresenceForRestart',
        'captureParkedTimeBanks',
        'isMaintenanceStateDurable',
        ...(stopped ? ['hasReleasedProcessOwnership'] : []),
      ];
      const authoritySymbols = Object.getOwnPropertySymbols(engine).filter(
        (symbol) => symbol.description === 'smarter.tournament-data-authority'
      );
      let authority = null;
      if (engine.engineLeaseScope === 'tournament') {
        require(authoritySymbols.length === 1, 'engine_authority_invalid');
        const descriptor = Object.getOwnPropertyDescriptor(engine, authoritySymbols[0]);
        authority = descriptor?.value;
        require(descriptor?.configurable === false &&
          descriptor.enumerable === false &&
          descriptor.writable === false &&
          record(authority) &&
          Object.isFrozen(authority) &&
          Object.keys(authority).sort().join(',') === 'actor,leaseGeneration,tournamentId' &&
          authority.actor === 'tournament-manager' &&
          uuid(authority.tournamentId) &&
          authority.tournamentId === authority.tournamentId.toLowerCase() &&
          uuid(authority.leaseGeneration) &&
          authority.leaseGeneration === authority.leaseGeneration.toLowerCase() &&
          engine.engineLeaseVerified === true &&
          typeof engine.engineLeaseTournamentId === 'string' &&
          engine.engineLeaseTournamentId.toLowerCase() === authority.tournamentId &&
          typeof engine.engineLeaseGeneration === 'string' &&
          engine.engineLeaseGeneration.toLowerCase() ===
            authority.leaseGeneration, 'engine_authority_invalid');
        // The actual binder only constructs a closure here: it is not invoked,
        // does not rebind the live engine and makes no request. Source equality
        // recognizes its wrappers; exact live references are fenced below. This
        // is source-bound admission, not attestation against arbitrary code in
        // the already-privileged process.
        const wrapperSource = Function.prototype.toString.call(
          modules.dataActorContext.bindTournamentDataAuthority(
            authority,
            base.persistPresenceForRestart
          )
        );
        for (const name of methodNames) {
          const method = Object.getOwnPropertyDescriptor(engine, name);
          require(method &&
            typeof method.value === 'function' &&
            Function.prototype.toString.call(method.value) ===
              wrapperSource, 'engine_method_mismatch');
        }
      } else {
        require(authoritySymbols.length === 0 &&
          methodNames.every((name) => engine[name] === base[name]), 'engine_method_mismatch');
      }
      const methods = methodNames.map((name) => engine[name]);
      if (stopped) {
        // The old native gate omits stopped map entries. Omit only a genuinely
        // empty terminal owner, and join its actual successful teardown before
        // any write below. A failed/unknown or bank-bearing stopped generation
        // is never silently dropped from custody.
        require(engine.terminal === true &&
          engine.teardownPromise instanceof Promise &&
          engine.dealingLoopPromise === null &&
          engine.readContinuationTasks instanceof Set &&
          engine.readContinuationTasks.size === 0 &&
          engine.hasReleasedProcessOwnership() === true &&
          engine.handController === null, 'stopped_engine_not_released');
      } else {
        require(engine.running === true &&
          engine.terminal === false &&
          engine.teardownPromise === null &&
          engine.maintenancePaused === true &&
          engine.holdBeforeNextHand === true &&
          typeof engine.handForHandResolve === 'function' &&
          engine.handController === null, 'engine_not_physically_parked');
      }
      require(engine.settlementInFlight instanceof Set &&
        engine.settlementInFlight.size === 0 &&
        engine.postHandTasksPromise === null &&
        engine.actionLock === false &&
        engine.tournamentMoveOperations instanceof Set &&
        engine.tournamentMoveOperations.size === 0 &&
        engine.terminalBoundaryPendingGenerations instanceof Set &&
        engine.terminalBoundaryPendingGenerations.size <=
          boundaryGenerationsAllowed(tableId, engine) &&
        (engine.terminalBoundaryPersistenceFailed === false ||
          deadBoundaryFailureDeferred(tableId, engine)), 'engine_work_not_drained');
      require(Number.isSafeInteger(engine.handCount) &&
        engine.handCount >= 0 &&
        Array.isArray(engine.seatedPlayers) &&
        engine.seatedPlayers.length <= maxEntriesPerTable &&
        engine.timeBankMeta instanceof Map &&
        engine.timeBankMeta.size <= maxEntriesPerTable &&
        engine.timeBankEngine?.playerBanks instanceof Map &&
        engine.timeBankEngine.playerBanks.size <= maxEntriesPerTable &&
        engine.presenceSave instanceof Promise &&
        record(engine.parkedTimeBanks) &&
        Object.keys(engine.parkedTimeBanks).length <= maxEntriesPerTable, 'bank_collection_shape');
      const seats = new Map();
      const seatIds = new Set();
      for (const seat of engine.seatedPlayers) {
        require(record(seat) &&
          uuid(seat.user_id) &&
          !seatIds.has(seat.user_id.toLowerCase()), 'seat_identity_invalid');
        seatIds.add(seat.user_id.toLowerCase());
        seats.set(seat.user_id, seat);
      }
      /* ═══ A BANK THE ENGINE NO LONGER HOLDS IS NOT CUSTODY (2026-09-22) ═══

         8825 only; every other profile refuses exactly as before. The note
         above `bankShape` has the source lines. Two shapes the live 8825
         fleet cannot avoid, and neither is waved through:

         RESIDUE - a bank, or its metadata, for a player this engine no longer
         seats (a cashout, a move, an eviction, a tournament bust). 8825's own
         `captureParkedTimeBanks` walks the roster only, so nothing here is
         written by the checkpoint or restored by its successor. It could
         still be custody two ways, and both are proved from rows before
         anything is written: a roster that is merely stale (a live occupancy
         the engine forgot), so no residue pair may have an open `table_seats`
         row; and a CASH SEAT MOVE still in transit (the carried presence and
         bank wait in the process-wide SeatMovePresence map until the
         destination's seat sweep claims them), so a move out of a residue
         table into a seat whose capture holds no bank for that occupancy, and
         executed within the last hour, refuses. An active timer is refused
         outright.

         DISPOSED - metadata for a seated player on a STOPPED engine whose
         `stop()` disposed every bank. The live value is already gone and no
         refusal can bring it back; the metadata is only its accounting mirror
         (`timeBankAccountingPending`/`Unconfirmed` were required drained
         above). Only a stopped engine that holds no bank at all qualifies,
         and its felt is proved quiet from `hand_state_snapshots` (the same
         120 s predicate as the release gate) before anything is written.

         Both sets are part of the signature, so a set that MOVES between
         observations refuses as `engine_state_changed`; `proveBanksHeldNothing`
         reads the rows, and refuses on any row it cannot rule out, any error
         and any page that fills. */
      const residue = new Set();
      for (const [key, bank] of engine.timeBankEngine.playerBanks) {
        require(record(bank) &&
          bank.tableId === tableId &&
          uuid(bank.playerId) &&
          key === `${tableId}:${bank.playerId}` &&
          (seats.has(bank.playerId) ||
            (retained8825 && bank.isActive === false)), 'bank_occupancy_mismatch');
        if (!seats.has(bank.playerId)) residue.add(bank.playerId.toLowerCase());
      }
      /* ═══ A LIVE SEAT BETWEEN ITS BANKS IS NOT CUSTODY (2026-09-24) ═══

       Run 36026978112 refused `bank_metadata_without_bank` on 3a294223 with
       `stopped=false terminal=false scope=cash seats=2 banks=1
       metaSeatedWithoutBank=1 fleetLiveSeatedMeta=1`: ONE live cash table, out
       of 439 walked, whose seated player held accounting metadata and no live
       bank. The release refused the whole fleet for it.

       That shape is ordinary operation, and it is transient. 8825 creates a
       seat's bank and its metadata TOGETHER, at deal time, in one branch
       (ServerTableEngineDealing.ts:2955: `if (!getPlayerBank(...))`
       `initializePlayer` then `timeBankMeta.set`). It removes the bank in
       seven places and deletes the metadata in exactly one, the cash branch of
       `adoptSeatRoster` (ServerTableEngineBase.ts:4283), which only runs for a
       user the next roster no longer holds. So a player who is removed and
       re-seated at the same table - a cashout and a re-seat, a bust and a
       rebuy, a sit-out eviction and a return - keeps the metadata, loses the
       bank, and gets BOTH back at the next deal. The break is what stopped
       that deal from happening.

       NOTHING IS PERSISTED FOR SUCH A SEAT, EITHER WAY. 8825's own
       `captureParkedTimeBanks` walks the roster and skips a seat with no bank
       (`if (!bank) continue`, :5531), so the row this checkpoint writes is
       identical whether this require passes or refuses, and the successor
       seeds the ordinary allowance at its first deal exactly as this engine
       would have at its next one. The refusal protected no value. What it did
       do was make the release a lottery: one table in four hundred, mid-rebuy
       at the wrong second, refuses everything.

       THE STOPPED CASE IS UNTOUCHED AND IS WHERE THE PROTECTION LIVES. A
       STOPPED engine still qualifies only by holding no bank at all, so a
       stopped engine that kept some of its banks refuses here exactly as
       before, one require earlier than `stopped_engine_retains_custody` would.

       ONE CONJUNCT IS ADDED AND IT IS `!stopped`, DELIBERATELY. Everything
       else this case needs is already PROVED, for this engine, a few requires
       above: a non-stopped engine reached here only through
       `engine_not_physically_parked`, which required `running === true`,
       `terminal === false`, `teardownPromise === null`, `maintenancePaused ===
       true`, `holdBeforeNextHand === true` and `handController === null`, and
       through `engine_work_not_drained`, which required no settlement, no
       post-hand tasks, no move operations and a clean boundary. Repeating any
       of them here would add a conjunct no test could ever make false, which
       is how a guard fills up with checks nobody can reason about. The law
       test asserts that ordering and those conditions instead, so the
       dependency is pinned rather than duplicated.

       AND IT IS STILL PROVED FROM ROWS. The seat joins `disposed`, and
       `proveBanksHeldNothing` already asks, for every table holding a disposed
       seat and without regard to whether its engine is stopped, whether the
       felt is quiet - the same 120s incomplete-snapshot predicate as the
       release gate. A hand in the air on that table still refuses the whole
       checkpoint, from rows, before anything is written. */
      const disposed = new Set();
      for (const userId of engine.timeBankMeta.keys()) {
        const seated = seats.has(userId);
        if (seated && engine.timeBankEngine.playerBanks.has(`${tableId}:${userId}`)) continue;
        require(retained8825 &&
          uuid(userId) &&
          (!seated ||
            !stopped ||
            engine.timeBankEngine.playerBanks.size === 0), 'bank_metadata_without_bank');
        (seated ? disposed : residue).add(userId.toLowerCase());
      }
      const expectedBanks = {};
      for (const [userId, bank] of Object.entries(engine.parkedTimeBanks)) {
        require(uuid(userId) &&
          validBank(bank) &&
          (seats.get(userId)?.occupancy_id === bank.occupancyId ||
            deadParkedBanksDeferred(tableId, engine)), 'parked_bank_invalid');
        expectedBanks[userId] = detached(bank);
      }
      let uninitialized = 0;
      for (const [userId, seat] of seats) {
        const bank = engine.timeBankEngine.playerBanks.get(`${tableId}:${userId}`);
        const meta = engine.timeBankMeta.get(userId);
        if (!bank && !meta) {
          // No bank is created until this occupancy first participates in a hand.
          if (!Object.hasOwn(expectedBanks, userId)) uninitialized++;
          continue;
        }
        // DISPOSED above: a stop took the bank; there is nothing live to persist.
        if (!bank && disposed.has(userId.toLowerCase())) continue;
        require(record(bank) &&
          record(meta) &&
          bank.isActive === false &&
          uuid(seat.occupancy_id), 'bank_active_or_incomplete');
        const saved = {
          occupancyId: seat.occupancy_id,
          remainingSeconds: bank.remainingSeconds,
          usesRemaining: bank.usesRemaining,
          ...meta,
          ...(retained8825 ? { unlimitedActivations: bank.unlimitedActivations } : {}),
        };
        require(validBank(saved) &&
          Object.keys(saved).sort().join(',') ===
            (retained8825
              ? 'baseSeconds,dbConsumedSeconds,initialSeconds,occupancyId,remainingSeconds,unlimitedActivations,usesRemaining'
              : 'baseSeconds,dbConsumedSeconds,initialSeconds,occupancyId,remainingSeconds,usesRemaining') &&
          (!retained8825 ||
            typeof saved.unlimitedActivations === 'boolean'), 'bank_not_restorable');
        expectedBanks[userId] = detached(saved);
      }
      require(canonical(engine.captureParkedTimeBanks()) ===
        canonical(expectedBanks), 'bank_capture_mismatch');
      const states = detached(engine.disconnectEngine.getFsmStatesForTable(tableId));
      require(record(states) &&
        Object.keys(states).length <= maxEntriesPerTable &&
        JSON.stringify(states).length <= 65536, 'presence_bound_or_shape');
      if (stopped) {
        // On 8825 every metadata entry of a stopped engine was classified above
        // as residue or disposed, and both are proved from rows before a write.
        require((retained8825 || engine.timeBankMeta.size === 0) &&
          engine.timeBankEngine.playerBanks.size === 0 &&
          (Object.keys(engine.parkedTimeBanks).length === 0 ||
            deadParkedBanksDeferred(tableId, engine)) &&
          Object.keys(states).length === 0, 'stopped_engine_retains_custody');
      }
      /* ═══ PRESENCE IS OBSERVED; CUSTODY IS HELD (2026-09-24) ═══

         Run 36056765988 (the 20:55 break) is the measurement: the first
         release since 2026-09-22 to clear every capture refusal, every row
         proof and the previous-work join, write 79 tables' park rows, and
         then refuse `engine_state_changed` on the re-verification after the
         write - naming nothing, because that require was the process-wide
         one. Every part of this signature but one is frozen by the break
         itself: the hand number (parked), the roster and stacks (the engine's own
         half of the freeze, immediately below), the banks (no hand, no
         timer), and the residue and disposed sets that derive from them. The
         one part the freeze does not touch is the disconnect FSM: a player's
         socket drops or comes back during the five minutes exactly as it does
         at any other time, and on a live fleet of hundreds of tables one of
         them will, in the seconds between the capture and the write. That is
         presence, which the successor re-observes from heartbeats within
         seconds of adopting the row; it is not custody, and refusing the
         whole release on it is the same forever-block one level up (CLAUDE.md
         10.86 rule 4).

         So the signature is split. CUSTODY - hand number, roster, banks,
         residue, disposed - must not move between observations, and a move
         refuses exactly as before, now naming its table and the field.
         PRESENCE may change its VALUES between observations and the newest
         observation is adopted; its REGISTRY - which players have a state at
         all - may not, because a player appearing or vanishing from it is a
         roster event the freeze forbids, and that still refuses. The readback
         holds the row's presence to the same rule: the same players, each
         with a record, not the same bytes. */
      /* ═══ WHICH HALF OF THE FREEZE HOLDS THE ROSTER STILL (2026-09-24) ═══

         The paragraph above named the Postgres half. For the roster it is the
         wrong half twice over, and the correction matters because the whole
         argument for keeping seats and stacks in `custody` rests on it.

         FIRST, the Postgres half does not apply to this process.
         `fn_refuse_while_frozen`, the function behind `zz_freeze_guard` on
         `table_seats`, returns early when the caller's `request.jwt.claims`
         carry the service role, which is exactly what this engine presents.
         Verified against the live database on 2026-09-24. That guard holds
         back browsers and pg_cron, which is what `freezeState.ts` says it is
         for ("the engine is dead for ~2 of the 5 minutes and pg_cron and
         browsers do not stop when it does"). It was never the engine's leash.

         SECOND, the signature does not read a row. `custody.roster` below
         reads `engine.seatedPlayers`, an in-memory array, and no trigger on
         any table can hold an array in this heap still.

         What does hold it is the ENGINE's half: the process-wide flag in
         `maintenance/freezeState.ts`, set from the ANNOUNCEMENT at :53 rather
         than the countdown at :55, and read on both paths that could move a
         seat under this walk. A top-up answers `Scheduled maintenance is in
         progress` on the first line of `addChips`, before it finds the seat
         and before any debit, so neither the stack nor the pending-add-on
         cache moves. And the wait-for-players sweep, the only caller that
         replaces `seatedPlayers` wholesale, meets the pause gate at the top
         of its loop before it reads seats or adopts a roster, so an arrival,
         a departure and an expired sit-out all wait for the resume.

         Both gates are now pinned by
         `tests/a-seat-does-not-move-under-a-release-walk.law.test.ts`, which
         also pins this signature's dependency on them. Before it, deleting
         either gate left every suite green and turned the next release back
         into the lottery #5215 had just removed. */
      const custody = {
        handNumber: engine.handCount,
        roster: engine.seatedPlayers.map((seat) => [
          seat.user_id,
          seat.occupancy_id ?? null,
          seat.seat_number,
          seat.stack,
        ]),
        banks: expectedBanks,
        ...(retained8825 ? { residue: [...residue].sort(), disposed: [...disposed].sort() } : {}),
      };
      const custodySignature = canonical(custody);
      const presenceRegistry = canonical(Object.keys(states).sort());
      const signature = canonical({ ...custody, states });
      return {
        tableId,
        engine,
        custody,
        custodySignature,
        presenceRegistry,
        methods,
        authority,
        stopped,
        teardown: engine.teardownPromise,
        handNumber: engine.handCount,
        banks: expectedBanks,
        states,
        signature,
        uninitialized,
        residue: [...residue].sort(),
        disposed: [...disposed].sort(),
        pause: engine.handForHandResolve,
        timer: engine.pauseGateTimer,
        bankEngine: engine.timeBankEngine,
        bankMeta: engine.timeBankMeta,
        presenceSave: engine.presenceSave,
        accountingPending: trackedAccounting ? engine.timeBankAccountingPending : null,
        checkpointGeneration: trackedAccounting ? engine.maintenanceCheckpointGeneration : null,
        requiresRow: Object.keys(states).length + Object.keys(expectedBanks).length > 0,
        writeStartedAt: null,
        writeEndedAt: null,
      };
    };
    progress('captureMixedOriginals');
    const retainedEngines = retained8825 ? await captureMixedOriginals() : new Set();
    /* ═══ AN ENGINE THAT NEVER STARTED HOLDS NOTHING TO CHECKPOINT (2026-09-21) ═══

       The live 8825 engine re-admits the cash table 3c00d4d0 every few seconds:
       `ensureCashTableEngineAdmission` does `this.tableEngines.set(tableId,
       engine)` BEFORE `void engine.start()` (GameServer.ts:9665-9684), start()
       sets `running = true` and `loopPhase = 'start_load_table'` before its
       first await (ServerTableEngineBase.ts:2960-2965), `checkCrashRecovery`
       throws `retained_hand_submission_pending`, and the catch runs
       `killForRestart('start_failed:start_load_table')` (3387), which sets
       `terminal = true; running = false; handController = null` (4711-4712,
       4735). `recoverDirectTableEngine` then awaits `engine.stop()` (so
       `teardownPromise` is a Promise) and only then `tableEngines.delete`
       (GameServer.ts:1660-1706). The snapshot above caught that object in
       the map on most attempts, `captureEngine` pinned it, and its scheduled
       departure refused the whole checkpoint.

       Such an object owns nothing this checkpoint persists. `seatedPlayers` is
       filled only by `adoptSeatRoster` from the wait-for-players loop, which
       runs after the `waiting` transition (3217, 4259); `handsDealtThisSession`
       is incremented only when a hand is dealt (ServerTableEngineDealing.ts:
       1833); the dealing loop is installed only at the end of start() (3355);
       and `parkedTimeBanks`/presence are read only after crash recovery
       (3130-3141). `handCount` is NOT a witness: `seedHandCountFromHistory`
       (3093) restores the last persisted hand number before the failure.

       The exclusion is the conjunction below and nothing wider: 8825 only,
       the direct cash lane only (never a tournament-owned table, never a
       retained original, never an F06 movement admission), loop phase still
       `not_started`/`start_load_table`, no dealing loop, zero hands dealt this
       session, no hand controller, no seat, no bank, no bank metadata, no
       parked bank, no presence state, no in-flight settlement or boundary.
       Anything else is captured and pinned exactly as before. */
    const ownedTables = server.tournamentOwnedTables;
    const neverStarted = (tableId, engine) => {
      if (!retained8825) return false;
      try {
        return (
          engine instanceof modules.base.ServerTableEngineBase &&
          engine.tableId === tableId &&
          !retainedEngines.has(engine) &&
          ownedTables instanceof Set &&
          !ownedTables.has(tableId) &&
          engine.engineLeaseScope === 'cash' &&
          engine.engineLeaseVerified === true &&
          engine.f06MovementAdmission === null &&
          engine.f06CurrentPermit === null &&
          engine.f06RecoveryInFlight === false &&
          (engine.loopPhase === 'start_load_table' || engine.loopPhase === 'not_started') &&
          engine.dealingLoopPromise === null &&
          engine.handsDealtThisSession === 0 &&
          engine.handController === null &&
          Array.isArray(engine.seatedPlayers) &&
          engine.seatedPlayers.length === 0 &&
          engine.timeBankMeta instanceof Map &&
          engine.timeBankMeta.size === 0 &&
          engine.timeBankEngine?.playerBanks instanceof Map &&
          engine.timeBankEngine.playerBanks.size === 0 &&
          record(engine.parkedTimeBanks) &&
          Object.keys(engine.parkedTimeBanks).length === 0 &&
          engine.timeBankAccountingPending instanceof Set &&
          engine.timeBankAccountingPending.size === 0 &&
          engine.timeBankAccountingUnconfirmed === false &&
          engine.settlementInFlight instanceof Set &&
          engine.settlementInFlight.size === 0 &&
          engine.postHandTasksPromise === null &&
          engine.tournamentMoveOperations instanceof Set &&
          engine.tournamentMoveOperations.size === 0 &&
          engine.terminalBoundaryPendingGenerations instanceof Set &&
          engine.terminalBoundaryPendingGenerations.size === 0 &&
          engine.terminalBoundaryPersistenceFailed === false &&
          (() => {
            const states = engine.disconnectEngine.getFsmStatesForTable(tableId);
            return record(states) && Object.keys(states).length === 0;
          })()
        );
      } catch {
        return false;
      }
    };
    // The watchdog kill and the stop that precede the map delete (8825
    // ServerTableEngineBase.ts:4711-4712 and 3445, GameServer.ts:1660-1706).
    const fencedNeverStarted = (tableId, engine) =>
      neverStarted(tableId, engine) &&
      engine.terminal === true &&
      engine.running === false &&
      engine.teardownPromise instanceof Promise;
    checkUnstarted = () => {
      for (const [tableId, tracked] of unstartedTables) {
        const current = tableMap.get(tableId);
        if (current === tracked.engine) {
          // Still the same object, started or fenced: it must still own nothing.
          witness(
            'engine_state_changed',
            [['unstarted.still_unstarted', () => neverStarted(tableId, current)]],
            () => ({ failedTable: `unstarted_acquired_custody:${tableId}` })
          );
        } else if (current === undefined) {
          // Departed: tolerated only for a fenced object that never dealt.
          witness(
            'engine_identity_changed',
            [['unstarted.departed_fenced', () => fencedNeverStarted(tableId, tracked.engine)]],
            () => ({ failedTable: `unstarted_departed_unfenced:${tableId}` })
          );
          if (!tracked.departed) {
            tracked.departed = true;
            unstartedDepartures++;
          }
        } else {
          // Replaced: the old object must be fenced and never have dealt, and the
          // successor must itself be an unstarted engine; then follow the successor.
          witness(
            'engine_identity_changed',
            [
              ['unstarted.replaced_fenced', () => fencedNeverStarted(tableId, tracked.engine)],
              ['unstarted.successor_unstarted', () => neverStarted(tableId, current)],
            ],
            () => ({ failedTable: `unstarted_replaced:${tableId}` })
          );
          tracked.engine = current;
          tracked.departed = false;
          unstartedReplacements++;
        }
      }
    };
    for (const [id, engine] of entries) {
      if (retainedEngines.has(engine)) continue;
      require(!engines.has(engine), 'engine_not_unique');
      require(uuid(id) && !tableIds.has(id.toLowerCase()), 'engine_identity_mismatch');
      tableIds.add(id.toLowerCase());
      engines.add(engine);
      if (neverStarted(id, engine)) {
        unstartedTables.set(id, { engine, departed: false });
        skippedUnstarted++;
        continue;
      }
      // The walk does not stop at the first refusal (see the census note
      // above). `reason` is already set by then, so nothing below this loop
      // runs: the throw at the end of it is the one the first refusal raised.
      const before = censusRefusals;
      try {
        const captured = captureEngine(id, engine);
        if (reason === null) captures.push(captured);
      } catch (error) {
        if (reason === null) throw error;
        if (censusRefusals === before) noteCensus(id, 'engine_capture_threw');
      }
    }
    if (reason !== null) throw new Error('legacy_checkpoint_refused');
    const checkEngine = (captured) => {
      require(tableMap.get(captured.tableId) === captured.engine, 'engine_identity_changed');
      const current = captureEngine(captured.tableId, captured.engine);
      require(current.authority === captured.authority &&
        current.stopped === captured.stopped &&
        current.teardown === captured.teardown &&
        current.methods.every(
          (method, index) => method === captured.methods[index]
        ), 'engine_method_changed');
      witness(
        'engine_state_changed',
        [
          ['engine.pause', () => current.pause === captured.pause],
          ['engine.timer', () => current.timer === captured.timer],
          ['engine.bankEngine', () => current.bankEngine === captured.bankEngine],
          ['engine.bankMeta', () => current.bankMeta === captured.bankMeta],
          ['custody', () => current.custodySignature === captured.custodySignature],
          ['presence.registry', () => current.presenceRegistry === captured.presenceRegistry],
        ],
        () => ({
          failedTable: captured.tableId,
          observedDetail: Object.keys(captured.custody)
            .filter((key) => canonical(current.custody[key]) !== canonical(captured.custody[key]))
            .map((key) => `moved=${key}`)
            .concat(
              current.presenceRegistry === captured.presenceRegistry
                ? []
                : [`presenceRegistry=${Object.keys(current.states).length}/${Object.keys(captured.states).length}`]
            )
            .join(',')
            .slice(0, 512),
        })
      );
      // Presence values are observed, not held: the newest observation is the
      // one the row will be read against (see the readback).
      captured.states = current.states;
      captured.signature = current.signature;
      require(current.presenceSave === captured.presenceSave, 'presence_writer_changed');
      require(current.accountingPending === captured.accountingPending &&
        current.checkpointGeneration ===
          captured.checkpointGeneration, 'native_checkpoint_owner_changed');
    };
    const checkAll = () => {
      const remaining = checkMaintenance();
      for (const captured of captures) checkEngine(captured);
      return remaining;
    };
    // THREE OUTCOMES, as in `proveAbandonedBoundaries`: no row it cannot rule
    // out is PROVED; a row it cannot rule out refuses; an error, a body that is
    // not a list or a page that fills is COULD NOT TELL, and refuses. There is
    // no flag, option or argument that turns a refusal here into permission.
    // The reads run concurrently (at most eight at a time) between ONE pair of
    // full re-verifications, so the proof costs one round of reads, not one per
    // page, inside the publisher's work budget.
    async function proveBanksHeldNothing(checkAll) {
      const residueTables = captures.filter((capture) => capture.residue.length > 0);
      const disposedTables = captures.filter((capture) => capture.disposed.length > 0);
      if (residueTables.length === 0 && disposedTables.length === 0) return;
      const lower = (value) => String(value).toLowerCase();
      const refuseAt = (check, table, code) => {
        noteRefusal(() => ({ failedCheck: check, failedTable: uuid(table) ? table : describe(table) }));
        refuse(code);
      };
      const chunks = (values, size) => {
        const out = [];
        for (let offset = 0; offset < values.length; offset += size) out.push(values.slice(offset, offset + size));
        return out;
      };
      const readAll = async (reads) => {
        const answers = new Array(reads.length);
        let next = 0;
        const worker = async () => {
          while (next < reads.length) {
            const index = next++;
            answers[index] = await reads[index]();
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, reads.length) }, worker));
        return answers;
      };
      // A read that fails names which read it was and the error code it got.
      const answered = (answer, ceiling, code, check) => {
        if (record(answer) && !answer.error && Array.isArray(answer.data) && answer.data.length <= ceiling)
          return;
        const errorCode = answer?.error?.code;
        noteRefusal(() => ({
          failedCheck: `proveBanksHeldNothing.${check}`,
          observedDetail: [
            `error=${typeof errorCode === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(errorCode) ? errorCode : describe(errorCode)}`,
            `rows=${Array.isArray(answer?.data) ? answer.data.length : describe(answer?.data)}`,
            `ceiling=${ceiling}`,
          ].join(','),
        }));
        refuse(code);
      };
      const held = new Set(residueTables.flatMap(({ tableId, residue }) =>
        residue.map((userId) => `${lower(tableId)}:${userId}`)));
      const residueUsers = [...new Set(residueTables.flatMap(({ residue }) => residue))].sort();
      checkAll();
      // 1. Every open seat each residue player holds, at ANY table. One HERE is
      // a live occupancy the engine no longer holds, and it is never residue.
      // A player holds at most a handful of seats, so a hundred players stay
      // far inside the 900-row ceiling, and a page that fills refuses.
      const open = [];
      const atResidueTable = [];
      for (const answer of await readAll(chunks(residueUsers, 100).map((users) => () =>
        modules.client.supabase
          .from('table_seats')
          .select('table_id,user_id,occupancy_id,joined_at')
          .in('user_id', users)
          .is('left_at', null)
          .limit(901)))) {
        answered(answer, 900, 'bank_residue_unproven', 'openSeatsRead');
        for (const row of answer.data) {
          require(record(row) &&
            uuid(row.table_id) &&
            uuid(row.user_id) &&
            uuid(row.occupancy_id), 'bank_residue_unproven');
          if (held.has(`${lower(row.table_id)}:${lower(row.user_id)}`)) atResidueTable.push(row);
          open.push(row);
        }
      }
      /* ═══ A SEAT THIS ENGINE NEVER DEALT HOLDS NONE OF ITS BANKS (2026-09-25) ═══

         Run 36098984451 (2026-09-25 05:39 UTC) refused here on
         a86077f2-80bc-4cb5-8f75-1220dab2615d - one open seat, out of the 2178
         this proof read, that happened to be at a table whose engine also held
         residue for that player. The two runs either side of it, minutes away
         on the same fleet, read the same 861 residue players and found no
         collision at all. The refusal is a race, and the race is ordinary
         operation.

         WHICH OCCUPANCY IS THE QUESTION, AND THE PLAYER IS NOT IT. `held` is
         keyed `table:player`, so ANY open row for that player at that table
         refuses - including one this engine has never adopted. That is not the
         shape the note above set out to catch. The shape it catches is a
         ROSTER THAT IS MERELY STALE: a LIVE OCCUPANCY the engine forgot, whose
         bank would then be dropped by a checkpoint that walks the roster.

         THE ROSTER CANNOT FORGET AN OCCUPANCY THE DATABASE STILL HOLDS OPEN.
         `seatedPlayers` is replaced wholesale, and only from
         `loadSeatedPlayers` (tables.ts:194), which reads exactly the rows with
         `left_at IS NULL`; `left_at` is stamped once and never cleared. Every
         engine-side removal closes the row in its own transaction FIRST and
         filters the roster after - the held leave (ServerTableEngineBase.ts
         :3969, on `res.ok`), the sit-out eviction (:8523, after
         `atomicCashout`), the executed seat move (:4410, confirmed moves
         only), leave-pending (ServerTableEngineDealing.ts:748, cashed-out ids)
         and the departure sweep (:1597). For a tournament seat the database is
         the sole authority and the engine "simply sees it absent from the next
         loadSeatedPlayers" (:446). So an OPEN row for a player the roster does
         not hold is a row the roster never held: a LATER occupancy, opened
         after the last sweep - and during this break the sweep does not run at
         all, because it meets the pause gate at the top of its loop before it
         reads seats (:3448, pinned by
         a-seat-does-not-move-under-a-release-walk.law.test.ts).

         AND A LATER OCCUPANCY OWNS NONE OF THIS ENGINE'S BANKS. A bank is
         bound to an occupancy in exactly three places: a DEAL
         (ServerTableEngineDealing.ts:3096, `if (!getPlayerBank(...))`),
         `applyParkedTimeBanks` (ServerTableEngineBase.ts:4598, only where
         `bank.occupancyId === seat.occupancy_id`) and a cash seat move's
         arrival claim (:4529). The last two require the player to BE in the
         roster, which a residue player is not, and a parked bank that matches
         no seat was already refused as `parked_bank_invalid` unless the whole
         table qualified as `deadParkedBanksDeferred`, which holds no seat, no
         bank and no metadata to be residue with. So the only way this engine
         holds a bank for THIS occupancy is that it dealt it a hand.

         SO THE SAME QUESTION IS ASKED FROM ROWS, ONCE PER COLLIDING SEAT: has
         `hand_history` recorded a hand at that table, at or after that seat
         opened, with that player in it? One row is enough and it refuses
         exactly as before. No row proves this engine never dealt that
         occupancy, so nothing it holds is that seat's custody, and the
         successor seeds the ordinary allowance at that seat's first deal -
         which is what `applyParkedTimeBanks` says a later seat occupant gets
         anyway ("later seat occupants keep ordinary allowance seeding").

         NOTHING ELSE MOVES. A collision whose seat WAS dealt - a roster that
         really is stale, a departure whose row-close was rolled back, a seat
         `loadSeatedPlayers` dropped because its profile would not resolve -
         still refuses, and still names this check and this table. An error, a
         body that is not a list, a page that fills and a row with no readable
         `joined_at` are all COULD NOT TELL and keep the refusal. And the
         question is only asked at all when a collision exists: on the runs
         either side of 36098984451 it cost no read. More than `readPageSize`
         of them at once is not a race and is refused without asking, because a
         fleet whose rosters have all gone stale is the condition this proof
         exists for. The read is the one at `dealtSinceRead` below, including
         its lesson: the containment value is sent as a JSON STRING, or
         PostgREST answers 22P02. */
      if (atResidueTable.length > readPageSize)
        refuseAt(
          'proveBanksHeldNothing.openSeatAtResidueTable',
          atResidueTable[0].table_id,
          'bank_residue_unproven'
        );
      let residueSeatsNeverDealt = 0;
      for (const [index, answer] of (await readAll(atResidueTable.map((row) => () =>
        typeof row.joined_at === 'string'
          ? modules.client.supabase
              .from('hand_history')
              .select('id')
              .eq('table_id', row.table_id)
              .gte('created_at', row.joined_at)
              .contains('players', JSON.stringify([{ userId: row.user_id }]))
              .limit(1)
          : Promise.resolve({ data: null, error: { code: 'seat_unjoined' } })))).entries()) {
        answered(answer, 1, 'bank_residue_unproven', 'residueSeatDealtRead');
        if (answer.data.length === 0) {
          residueSeatsNeverDealt++;
          continue;
        }
        refuseAt(
          'proveBanksHeldNothing.openSeatAtResidueTable',
          atResidueTable[index].table_id,
          'bank_residue_unproven'
        );
      }
      // 2. A residue player who left a residue table by a CASH SEAT MOVE and
      // still sits at that move's destination. The source deposited the carried
      // presence and bank in the process-wide SeatMovePresence map when it ran
      // the move (8825 ServerTableEngineBase.ts:4059-4061); the destination
      // claims it only in its seat sweep, after `adoptSeatRoster`, and a park
      // (or a failed arrival read, retried every 5 s) can come between. A
      // deposit is claimable for MOVED_PRESENCE_FRESH_MS (10 min,
      // SeatMovePresence.ts:94, :168) and only this process holds it.
      //
      // A destination whose CAPTURE holds a bank for that exact occupancy is
      // done: the claim made that bank, or a first deal did, and 8825 never
      // applies a carried bank or presence over a live one (:4233). Every other
      // open seat of a residue player is asked, through the engine's own
      // arrivals function (the service role cannot read the receipts table),
      // whether a cash seat move landed in it; one that executed within the
      // last hour refuses. A handoff is stamped at most ~16 min after the move
      // executes (ten moves a table, two attempts, three 15 s fetches each)
      // and claimable for ten more, so older ones can no longer be claimed.
      const captureOf = new Map(captures.map((capture) => [lower(capture.tableId), capture]));
      const pending = new Map();
      for (const row of open) {
        const bank = captureOf.get(lower(row.table_id))?.banks?.[row.user_id];
        if (record(bank) && lower(bank.occupancyId) === lower(row.occupancy_id)) continue;
        const table = lower(row.table_id);
        if (!pending.has(table)) pending.set(table, { tableId: row.table_id, occupancies: [] });
        pending.get(table).occupancies.push(row.occupancy_id);
      }
      const arrivals = [];
      const asked = [...pending.values()].sort((a, b) => (lower(a.tableId) < lower(b.tableId) ? -1 : 1));
      const admitArrival = (arrival) => {
        require(record(arrival) &&
          uuid(arrival.move_id) &&
          uuid(arrival.player_id) &&
          uuid(arrival.from_table_id) &&
          uuid(arrival.to_table_id) &&
          uuid(arrival.destination_occupancy_id), 'bank_residue_unproven');
        // Every arrival in hand counts, whatever its source still shows: a
        // swap partner, or a source engine replaced after running its move,
        // leaves no residue there, and its handoff is in transit all the same.
        arrivals.push(arrival);
      };
      /* ═══ ONE QUESTION FOR EVERY ARRIVAL (2026-09-24) ═══

         Run 36042895085 (the 18:55 break) is the measurement, from the
         progress record and the Supabase edge logs: the guard entered this
         proof 663 ms in, then made 767 `fn_cash_seat_move_arrivals` calls -
         one per destination table, eight at a time - between 18:55:11.975 and
         18:55:24.755, thirteen seconds of the publisher's 20000 ms work
         budget, and the call's outcome was lost. The database side of each
         call is under 10 ms (measured); the cost is the round trips.

         The same question, asked once: every receipt for these residue
         players whose destination seat is still open
         (`fn_cash_seat_move_arrivals_for_players`, the same join and the same
         ENGINE_ONLY gate, migration 20260924190214), filtered here to the
         exact (table, occupancy) pairs this guard holds no bank for. That is
         the union of the per-table answers, so nothing is admitted that the
         per-table question would have refused, and nothing it would have
         admitted is refused. At most 500 players a call, at most a handful of
         calls for the whole fleet, and still refused on any error or any page
         that fills. Until the function exists on the box (PostgREST answers
         PGRST202 to a function it cannot find) the per-table question is
         asked exactly as before, so a release that arrives ahead of the
         migration is no worse off than it was. */
      const pendingPairs = new Set(
        asked.flatMap(({ tableId, occupancies }) =>
          occupancies.map((occupancy) => `${lower(tableId)}:${lower(occupancy)}`)
        )
      );
      const askedPlayers = [...new Set(open
        .filter((row) => pendingPairs.has(`${lower(row.table_id)}:${lower(row.occupancy_id)}`))
        .map((row) => row.user_id))].sort();
      const byPlayer = askedPlayers.length === 0
        ? []
        : await readAll(chunks(askedPlayers, 500).map((players) => () =>
          modules.client.supabase.rpc('fn_cash_seat_move_arrivals_for_players', {
            p_player_ids: players,
          })));
      const batchMissing = byPlayer.some((answer) => answer?.error?.code === 'PGRST202');
      if (!batchMissing) {
        for (const answer of byPlayer) {
          answered(answer, 4000, 'bank_residue_unproven', 'arrivalsRead');
          for (const arrival of answer.data) {
            require(record(arrival) &&
              uuid(arrival.to_table_id) &&
              uuid(arrival.destination_occupancy_id), 'bank_residue_unproven');
            if (pendingPairs.has(`${lower(arrival.to_table_id)}:${lower(arrival.destination_occupancy_id)}`))
              admitArrival(arrival);
          }
        }
      } else {
        for (const [index, answer] of (await readAll(asked.map(({ tableId, occupancies }) => () =>
          modules.client.supabase.rpc('fn_cash_seat_move_arrivals', {
            p_table_id: tableId,
            p_occupancy_ids: [...occupancies].sort(),
          })))).entries()) {
          require(asked[index].occupancies.length <= 64, 'bank_residue_unproven');
          answered(answer, 64, 'bank_residue_unproven', 'arrivalsRead');
          for (const arrival of answer.data) admitArrival(arrival);
        }
      }
      const moveIds = [...new Set(arrivals.map(({ move_id }) => lower(move_id)))].sort();
      const executedAt = new Map();
      for (const answer of await readAll(chunks(moveIds, 200).map((ids) => () =>
        modules.client.supabase
          .from('cash_seat_moves')
          .select('id,executed_at')
          .in('id', ids)
          .limit(ids.length + 1)))) {
        answered(answer, 200, 'bank_residue_unproven', 'movesRead');
        for (const move of answer.data) {
          require(record(move) && uuid(move.id), 'bank_residue_unproven');
          executedAt.set(lower(move.id), move.executed_at);
        }
      }
      /* ═══ A MOVE THE DESTINATION HAS ALREADY DEALT IS NOT IN TRANSIT (2026-09-24) ═══

         Run 36050875490 (the 19:55 break) is the measurement: the first
         release to finish this proof inside its budget, refused at
         `seatMoveInTransit` on e4e522db for a move executed twenty-one
         minutes earlier - into a seat the destination had since dealt
         THIRTY-THREE hands to (hand_history, players[].userId). The one-hour
         rule below is a ceiling on how long a handoff can still be claimed;
         it says nothing about whether the claim still matters. Once the
         destination has dealt that seat a hand after the move, the bank is
         live there (ServerTableEngineDealing.ts:3036 seeds it on the deal)
         and 8825 never applies a carried bank or presence over a live one
         (:4233), so the deposit can no longer change anything, claimed or
         not. And this fleet executes a cash seat move every few minutes
         (414 receipts a day), so "no move in the last hour" is a window
         that is almost never open: the same forever-block one level up
         (CLAUDE.md 10.86 rule 4).

         So a move inside the hour is asked ONE more question, from rows: has
         `hand_history` recorded a hand at the destination table, after the
         move executed, with that player in it? One row is enough. No row, an
         error or an unreadable answer keeps the refusal exactly as it was.

         The containment value is sent as a JSON STRING. postgrest-js writes an
         array argument as a Postgres array literal (`cs.{...}`), so an array of
         objects reached PostgREST as invalid JSON and every read answered
         22P02 (release run 36081290135, 2026-09-25 01:24 UTC:
         failedCheck proveBanksHeldNothing.dealtSinceRead, error=22P02). A
         string is passed through verbatim. */
      const claimableSince = Date.now() - 3600000;
      const inWindow = arrivals.filter((arrival) => {
        const executed = Date.parse(executedAt.get(lower(arrival.move_id)));
        return !(Number.isFinite(executed) && executed < claimableSince);
      });
      let arrivalsDealtSince = 0;
      for (const [index, answer] of (await readAll(inWindow.map((arrival) => () => {
        const executed = executedAt.get(lower(arrival.move_id));
        return typeof executed === 'string'
          ? modules.client.supabase
              .from('hand_history')
              .select('id')
              .eq('table_id', arrival.to_table_id)
              .gt('created_at', executed)
              .contains('players', JSON.stringify([{ userId: arrival.player_id }]))
              .limit(1)
          : Promise.resolve({ data: [], error: null });
      }))).entries()) {
        const arrival = inWindow[index];
        answered(answer, 1, 'bank_residue_unproven', 'dealtSinceRead');
        if (answer.data.length === 1 && record(answer.data[0]) && uuid(answer.data[0].id)) {
          arrivalsDealtSince++;
          continue;
        }
        refuseAt('proveBanksHeldNothing.seatMoveInTransit', arrival.to_table_id, 'bank_residue_unproven');
      }
      // 3. The felt is quiet at every stopped table whose metadata outlived the
      // banks its stop disposed: the release gate's own predicate.
      const quietSince = new Date(Date.now() - inflightWindowMs).toISOString();
      for (const answer of await readAll(chunks(disposedTables.map(({ tableId }) => tableId), readPageSize).map((page) => () =>
        modules.client.supabase
          .from('hand_state_snapshots')
          .select('table_id,hand_number,stage,updated_at')
          .in('table_id', page)
          .eq('is_complete', false)
          .gte('updated_at', quietSince)
          .limit(page.length + 1)))) {
        answered(answer, readPageSize, 'stopped_disposed_banks_unproven', 'snapshotsRead');
        if (answer.data.length > 0)
          refuseAt('proveBanksHeldNothing.handInTheAir', answer.data[0]?.table_id, 'stopped_disposed_banks_unproven');
      }
      checkAll();
      const events = [...new Set(disposedTables.map(({ engine }) => {
        const event = engine?.engineLeaseTournamentId;
        return uuid(event) ? event.slice(0, 8) : 'none';
      }))].sort();
      bankDisposition = [
        `residueTables=${residueTables.length}`,
        `residuePlayers=${residueTables.reduce((sum, { residue }) => sum + residue.length, 0)}`,
        `residueOpenSeatsElsewhere=${open.length}`,
        `residueSeatsHere=${atResidueTable.length}`,
        `residueSeatsNeverDealt=${residueSeatsNeverDealt}`,
        `arrivalTablesAsked=${asked.length}`,
        `arrivalQuestion=${batchMissing ? 'perTable' : 'perPlayer'}`,
        `arrivalPlayersAsked=${askedPlayers.length}`,
        `arrivalsInWindowChecked=${arrivals.length}`,
        `arrivalsDealtSince=${arrivalsDealtSince}`,
        `disposedTables=${disposedTables.length}`,
        `disposedSeats=${disposedTables.reduce((sum, { disposed }) => sum + disposed.length, 0)}`,
        `disposedEvents=${events.slice(0, 12).join('/') || 'none'}`,
      ].join(',').slice(0, 512);
    }
    // Join the existing announcement/native park writes before taking the final
    // baseline. Pointer equality refuses any newly admitted presence writer.
    const previousJoins = captures.flatMap((capture) =>
      capture.stopped
        ? [
            { capture, join: 'presenceSave' },
            { capture, join: 'teardown' },
          ]
        : [{ capture, join: 'presenceSave' }]
    );
    /* ═══ A JOIN THAT NEVER COMES BACK IS NOT WAITED FOR (2026-09-24) ═══

       Run 36041108119 (the 17:55 break) is the measurement: the first release
       whose capture walk admitted or deferred every table and whose join
       named its members (#5198, #5201, #5202), and it ended as `inspector
       operation outcome unknown` - the guard's call outlived the publisher's
       20000ms work budget, and the only unbounded wait between the capture
       walk and that budget is this `Promise.allSettled`. A promise that will
       settle does so on the next tick: a park write that finished at the
       announcement, a teardown that finished when the table broke. One that
       is still pending seconds later is either a Supabase write the engine's
       client is still retrying (`persistPresenceForRestart` waits 5 s and
       tries once more) or a teardown a dead process will never finish, and
       waiting on it does not change which - it only turns a refusal this guard
       could NAME into an outcome nobody can read. So the join is bounded:
       every promise is raced against one shared budget, and a join that has
       not settled by then is reported like a rejection, with its table and
       its kind, by the code below. A pending `presenceSave` refuses (the
       engine's own write may still land, and this guard's must queue behind
       it); a pending `teardown` on a stopped engine that has already released
       process ownership - the only shape the capture admits - is dead work in
       exactly the sense the failed-teardown note above defines, and takes the
       same rows-proved deferral. The budget is what a join that is going to
       settle can never need (milliseconds) and what leaves the publisher's
       work budget its reads, its writes and its readback: 5000 of 20000 ms. */
    progress('joinPreviousWork');
    const joinBudgetMs = 5000;
    const pendingJoin = Object.assign(new Error('join did not settle within its budget'), {
      name: 'PendingJoin',
    });
    let joinTimer = null;
    const joinBudget = new Promise((_, reject) => {
      joinTimer = setTimeout(() => reject(pendingJoin), joinBudgetMs);
    });
    joinBudget.catch(() => undefined);
    const previousWork = await Promise.allSettled(
      previousJoins.map(({ capture, join }) => Promise.race([capture[join], joinBudget]))
    );
    clearTimeout(joinTimer);
    progress('joinedPreviousWork');
    /* ═══ A JOIN THAT DID NOT COME BACK NAMES NOTHING (2026-09-24) ═══

       Run 36008454881 is the measurement. It is the first release since
       2026-09-18 whose capture walk refused NOTHING - every table was admitted
       or deferred - and it stopped here instead, on
       `previous_native_work_unconfirmed`, carrying no `failedCheck`, no
       `failedTable` and no detail at all. This join covers two different
       promises on up to four hundred engines: the park/announcement write each
       captured engine owns, and the teardown of each stopped one. Which
       promise, on which table, and why, is the whole diagnosis, and none of it
       reached a reader. The guard's own comment above `bankShape` says what
       that costs: a refusal that names nothing is one maintenance break spent
       to learn one fact.

       Observability only, on a path that is already refusing. The condition,
       its code and its order are the exact ones above: `unfulfilled.length ===
       0` is `previousWork.every((entry) => entry.status === 'fulfilled')` over
       the same settled array, in the same order. Nothing is joined twice and
       no outcome moves.

       `words` is stricter than `describe` on purpose. A rejection message is
       written by the engine, not by this guard, so it is reduced to LETTERS,
       spaces and underscores before it travels: no digit, hyphen or separator
       survives, so no user id, table id, hand number, amount, card or token
       can reach a log through it, and what is left is the sentence the engine
       wrote. */
    const words = (value) => {
      try {
        if (typeof value !== 'string') return describe(value);
        const text = value.replace(/[^A-Za-z _]+/g, ' ').replace(/ +/g, ' ').trim();
        return text.length === 0 ? `string(${value.length})` : text.slice(0, 64);
      } catch {
        return 'unreadable';
      }
    };
    /* ═══ A TEARDOWN A DEAD PROCESS CAN NEVER FINISH (2026-09-24) ═══

       Run 36015361207 is the measurement. It is the first release whose
       capture walk admitted or deferred every table AND whose refusal named
       itself (#5198), and it stopped here, on eight stopped engines of one
       tournament whose lease the old process lost:

         previousNativeWork.teardown  failedTable 6557ebd8
         unfulfilled=8 presenceSave=0 teardown=8 stopped=true scope=tournament
         reason=Table engine ... teardown failed in operation

       That sentence is written in exactly one place in 8825,
       `performStop` (ServerTableEngineBase.ts:3613), and only at its END,
       after every step of the stop has run. `stop()` memoizes the promise
       (:3417), so the same rejection is returned for ever: nothing in this
       process will ever run that teardown again. The only thing that ends it
       is replacing the process, which is exactly what this join refused:
       CLAUDE.md 10.86, the fix for the wedge sitting behind the wedge, the
       same shape as the three deferrals above.

       WHAT A FAILED 8825 TEARDOWN CAN HAVE LEFT UNWRITTEN. `performStop`
       collects into that AggregateError from exactly three places, and
       carries on past each of them:

         1. an owned writer it joined rejected (the dealing loop, a
            settlement, the post-hand tasks, a tournament move, a read
            continuation: :3486). Each is a promise that has already SETTLED;
            this process never re-runs it, and what it committed is in the
            database. A hand it left open is an incomplete
            `hand_state_snapshots` row, which is exactly what the row proof
            below reads.
         2. the terminal snapshot flush failed (:3545). A failed write
            changes no row, and the row it would have replaced is not money:
            8825 says above `requestSnapshot` that "rehydrate() is never
            called and checkCrashRecovery() abandons in-flight hands", and
            `checkCrashRecovery` (:8116) takes only the hand number and the
            disconnect states from it, marks the hand complete, and leaves
            every player on the stack the rows hold. Completion itself is a
            different write (`complete_hand_snapshot`), never this flush.
         3. a module dispose threw (:3595): process memory, gone with the
            process either way.

       Every other throw in `performStop` leaves WITHOUT that sentence. The
       seat boundary tail (a cashout, :3511) rejects with its own error, before
       any cleanup runs, so it fails the exact-message conjunct below and
       still refuses. What this checkpoint itself persists for a table,
       its banks and presence, is asserted empty on this engine by
       `stopped_engine_retains_custody` before this point, and pinned by
       `checkAll` after it.

       THIS IS PINNED TO 8825 AND TO NOTHING WIDER. Later builds add a fourth
       source to the same AggregateError: `performStop` now captures a
       stopped tournament table's time banks into custody and records a
       failure to do so in the same array. On such a predecessor a failed
       teardown CAN hide an uncaptured bank, so it keeps refusing exactly as
       before, and so does every rejection that is not the exact 8825
       sentence for this table, every engine that is not stopped, terminal
       and fully released, and every `presenceSave` join on any engine.

       And a deferral is not a waiver: the table goes into the same
       `deferredUnresolvableCustody` map as the three cases above, and
       `proveUnresolvableCustody` refuses the whole checkpoint unless the rows
       prove that table quiet BEFORE anything is written. A hand in the air
       still refuses, from rows. */
    const deadTeardownFailureDeferred = (capture, failure) => {
      try {
        const engine = capture.engine;
        const tableId = capture.tableId;
        if (
          !retained8825 ||
          capture.stopped !== true ||
          engine.teardownPromise !== capture.teardown ||
          engine.running !== false ||
          engine.terminal !== true ||
          engine.terminalTeardownComplete !== false ||
          engine.hasReleasedProcessOwnership() !== true ||
          engine.handController !== null ||
          engine.dealingLoopPromise !== null ||
          engine.f06RecoveryInFlight !== false ||
          !(engine.timeBankEngine?.playerBanks instanceof Map) ||
          engine.timeBankEngine.playerBanks.size !== 0 ||
          !(failure instanceof Error) ||
          failure.name !== 'AggregateError' ||
          !Array.isArray(failure.errors) ||
          failure.errors.length === 0 ||
          failure.message !==
            `Table engine ${tableId} teardown failed in ${failure.errors.length} operation(s)`
        )
          return false;
        const label = `failedTeardown:${failure.errors.length}`;
        const prior = deferredUnresolvableCustody.get(tableId);
        deferredUnresolvableCustody.set(tableId, prior === undefined ? label : `${prior}+${label}`);
        return true;
      } catch {
        // Unreadable is never "dead". It keeps the original refusal.
        return false;
      }
    };
    /* ═══ WHAT IS ACTUALLY INSIDE THE REJECTION (2026-09-24) ═══

       #5198 named the eight tables whose teardown did not come back and the
       sentence each engine wrote. #5201 read `performStop` and bounded them,
       on the argument that the AggregateError it throws collects from exactly
       three places and that none of the three can hide an unwritten money
       fact on 8825. That argument is made from SOURCE. Nothing in the record
       says what the members of those eight aggregates actually were, so
       nothing confirms it from the running fleet, and a release that steps
       over a rejection leaves no account of what it stepped over.

       This is that account, and it covers BOTH sets: the joins that still
       refuse, and the teardowns the deferral above admitted. The second set
       is the more important one, by the rule the guard already applies to
       `unresolvableCustody` - the record of a refusal that did not happen
       still has to reach a reader - so this is emitted on the path that
       proceeds as well as the path that refuses.

       Observability only. It reads rejections `Promise.allSettled` has
       already settled, in the order the filter above visited them; nothing is
       joined twice, no promise is created, `deadTeardownFailureDeferred` is
       called exactly once per teardown rejection exactly as before, and no
       condition, code or order moves.

       WHAT TRAVELS. A member's TYPE and its structured CODE are written by
       the runtime, not by a player: `AggregateError`, `PostgrestError`,
       `23505`, `PGRST116`, an HTTP status. Both are held to an identifier
       character class and a length, so a type-shaped or code-shaped value
       that is not one reduces to `unknown` or `none` rather than carrying
       what it holds. A member's MESSAGE goes through the same `words`
       reduction as the aggregate's: letters, spaces and underscores only, so
       no user id, table id, hand number, amount, card or token can travel
       through it. Signatures and sentences are counted and de-duplicated, so
       eight copies of one failure cost one. */
    const memberName = (value) => {
      try {
        if (value === null || value === undefined) return describe(value);
        const name = typeof value.name === 'string' ? value.name : value.constructor?.name;
        return typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name)
          ? name
          : 'unknown';
      } catch {
        return 'unreadable';
      }
    };
    const memberCode = (value) => {
      try {
        const code = value?.code ?? value?.status ?? null;
        if (typeof code === 'number' && Number.isSafeInteger(code) && code >= 0) return String(code);
        return typeof code === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(code) ? code : 'none';
      } catch {
        return 'unreadable';
      }
    };
    // An `AggregateError`'s members, or the rejection itself when it carries
    // none. A member that is itself an aggregate is NOT unwrapped further: one
    // level is what `performStop` builds, and an unbounded walk is not.
    const membersOf = (reason) => {
      try {
        if (Array.isArray(reason?.errors)) return reason.errors.slice(0, maxEntriesPerTable);
        return reason === null || reason === undefined ? [] : [reason];
      } catch {
        return [];
      }
    };
    const rejected = previousWork
      .map((entry, index) => ({ entry, ...previousJoins[index] }))
      .filter(({ entry }) => entry.status !== 'fulfilled');
    // A teardown still pending after the join budget on an engine the capture
    // admitted as stopped and released: see the bounded join above. The same
    // predicates as the failed case, minus the rejection it never produced.
    const deadTeardownPendingDeferred = (capture, failure) => {
      try {
        const engine = capture.engine;
        const tableId = capture.tableId;
        if (
          failure !== pendingJoin ||
          !retained8825 ||
          capture.stopped !== true ||
          engine.teardownPromise !== capture.teardown ||
          engine.running !== false ||
          engine.terminal !== true ||
          engine.terminalTeardownComplete !== false ||
          engine.hasReleasedProcessOwnership() !== true ||
          engine.handController !== null ||
          engine.dealingLoopPromise !== null ||
          engine.f06RecoveryInFlight !== false ||
          !(engine.timeBankEngine?.playerBanks instanceof Map) ||
          engine.timeBankEngine.playerBanks.size !== 0
        )
          return false;
        const label = 'pendingTeardown';
        const prior = deferredUnresolvableCustody.get(tableId);
        deferredUnresolvableCustody.set(tableId, prior === undefined ? label : `${prior}+${label}`);
        return true;
      } catch {
        // Unreadable is never "dead". It keeps the original refusal.
        return false;
      }
    };
    const unfulfilled = rejected.filter(
      ({ entry, capture, join }) =>
        !(
          join === 'teardown' &&
          (deadTeardownFailureDeferred(capture, entry.reason) ||
            deadTeardownPendingDeferred(capture, entry.reason))
        )
    );
    if (rejected.length > 0) {
      try {
        const signatures = new Map();
        const sentences = new Map();
        const refusing = new Set(unfulfilled);
        let members = 0;
        for (const item of rejected) {
          const prefix = refusing.has(item) ? 'r' : 'd';
          for (const member of membersOf(item.entry.reason)) {
            members++;
            const signature = `${prefix}.${memberName(member)}(${memberCode(member)})`;
            signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
            const sentence = words(member?.message).slice(0, 48);
            sentences.set(sentence, (sentences.get(sentence) ?? 0) + 1);
          }
        }
        const ranked = (entries) =>
          [...entries].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
        nativeWorkMembers = [
          `joins=${rejected.length}`,
          `deferredJoins=${rejected.length - unfulfilled.length}`,
          `refusingJoins=${unfulfilled.length}`,
          `members=${members}`,
          ...ranked(signatures).map(([signature, count]) => `${signature}=${count}`),
          `words=${ranked(sentences)
            .slice(0, 6)
            .map(([sentence]) => sentence)
            .join('/')}`,
        ]
          .join(' ')
          .slice(0, 512);
      } catch {
        // An unreadable witness is never a decision, and never a blank record.
        nativeWorkMembers = 'members=unreadable';
      }
    }
    if (unfulfilled.length > 0) {
      const first = unfulfilled[0];
      const counted = (join) => unfulfilled.filter((item) => item.join === join).length;
      const deferredTeardowns = () =>
        [...deferredUnresolvableCustody.values()].filter((label) => label.includes('failedTeardown:'))
          .length;
      noteRefusal(() => ({
        failedCheck: `previousNativeWork.${first.join}`,
        failedTable: uuid(first.capture.tableId)
          ? first.capture.tableId
          : describe(first.capture.tableId),
        observedDetail: [
          `unfulfilled=${unfulfilled.length}`,
          `joined=${previousWork.length}`,
          `presenceSave=${counted('presenceSave')}`,
          `teardown=${counted('teardown')}`,
          `teardownDeferred=${deferredTeardowns()}`,
          `stopped=${first.capture.stopped}`,
          `scope=${describe(first.capture.engine?.engineLeaseScope)}`,
          `tournament=${
            uuid(first.capture.engine?.engineLeaseTournamentId)
              ? first.capture.engine.engineLeaseTournamentId
              : 'none'
          }`,
          `reason=${words(first.entry.reason?.message)}`,
          `members=${membersOf(first.entry.reason).length}`,
          `tables=${unfulfilled
            .slice(0, 12)
            .map((item) => `${String(item.capture.tableId).slice(0, 8)}:${item.join}`)
            .join('/')}`,
        ]
          .join(',')
          .slice(0, 512),
      }));
    }
    require(unfulfilled.length === 0, 'previous_native_work_unconfirmed');
    checkAll();
    // Order is load-bearing: the rows prove that the residue and the disposed
    // banks hold nothing, and that no deferred unresolvable permit has a hand
    // in the air, BEFORE any presence or bank row is written.
    progress('proveUnresolvableCustody');
    await proveUnresolvableCustody(checkAll);
    progress('proveBanksHeldNothing');
    if (retained8825) await proveBanksHeldNothing(checkAll);
    bankCount = captures.reduce((sum, capture) => sum + Object.keys(capture.banks).length, 0);
    uninitializedSeats = captures.reduce((sum, capture) => sum + capture.uninitialized, 0);
    /* ═══ A DEAD GENERATION PROVES ITS PARK FROM THE ROW IT READ (2026-09-24) ═══

       Run 36061780372 (the 21:36 recovery window) is the measurement: the
       first release since 2026-09-22 to clear every capture refusal, every row
       proof and the previous-work join, and then refuse
       `native_checkpoint_unconfirmed` after all 83 park writes returned. The
       Supabase edge logs for those thirteen seconds hold 22 `POST 403
       engine_presence_parked`, and the Postgres logs hold the same 22 as
       `TOURNAMENT_MANAGER_FENCED: lease generation is no longer current`,
       raised by `smarter_private.fn_smarter_data_api_pre_request`. Eleven
       tables, each written once and once more five seconds on (8825's own
       `parkWriteRetryMs`), and every one of them a `parkedNoRoster` deferral:
       a STOPPED, TERMINAL tournament engine whose lease heartbeat stopped on
       2026-09-22, holding the banks it had read from `engine_presence_parked`
       at `start()` and never seated anybody to claim. Its
       `persistPresenceForRestart` is bound to that dead generation
       (`bindTournamentDataAuthority`), the request carries it, and the
       database refuses it - CORRECTLY. A generation that is no longer current
       must not write tournament data; that fence is the platform's own rule
       and this guard does not argue with it. `savePresenceAtPark` returns
       false, `parkedBankSaveComplete` stays false, and the whole release
       refused for a write the database was right to refuse.

       THE WRITE WAS NEVER NEEDED. The deferral above (`deadParkedBanksDeferred`)
       already says why: 8825's `captureParkedTimeBanks` starts from
       `{ ...this.parkedTimeBanks }` and this engine seats nobody, so the row
       the checkpoint would write is the row the engine READ, at the same
       `handNumber` - on 8825 `parkedTimeBanks` is filled from nowhere but
       `loadTimeBanksFromPark`, and only when `snapshot.handNumber ===
       this.handCount`. Writing it again changes nothing the successor will
       read, and on a dead generation cannot be done at all.

       So the row is asked FIRST, before anything is written. A `parkedNoRoster`
       capture whose row still says what the engine holds - a snapshot of the
       shape `loadTimeBanksFromPark` accepts, at the captured hand, every bank
       the engine holds in it byte for byte, any other entry one the loader
       would skip as unrestorable, and no presence the successor would still
       read (`PARKED_PRESENCE_FRESH_MS`) - is NOT written: the row is its
       proof. A capture whose row does NOT say that stays on the write path
       exactly as before - a cash engine, or one whose lease is still current,
       gets its row rewritten and read back inside its own write window; one
       whose generation is dead gets the same fenced refusal as today, now
       naming the table, the deferral and which check the row failed. Nothing
       is admitted on "could not tell": an unreadable row is simply not a
       proof, and the write path answers instead.

       THIS IS NOT "A DEAD ENGINE IS EXCUSED FROM THE CHECKPOINT". Nothing in
       the capture walk moves: the engine still has to be stopped, terminal,
       released, drained, holding no live bank, no metadata and no roster, and
       the rows still have to prove its felt quiet before anything is written
       for anyone. A live engine, or a dead one that seats a player, still
       writes and is still read back inside its own write window, exactly as
       before. What changes is only that a row the engine cannot rewrite, and
       need not, is held to the standard the write would have been. */
    const rowProvedCustody = new Set();
    const rowUnproven = new Map();
    const provedDetail = [];
    {
      const candidates = captures.filter((capture) =>
        capture.requiresRow &&
        /(^|\+)parkedNoRoster:/.test(String(deferredUnresolvableCustody.get(capture.tableId)))
      );
      if (candidates.length > 0) progress('proveParkedRows');
      for (let offset = 0; offset < candidates.length; offset += readPageSize) {
        checkAll();
        const page = candidates.slice(offset, offset + readPageSize);
        const { data, error } = await modules.client.supabase
          .from('engine_presence_parked')
          .select('table_id,engine_instance,parked_at,time_bank_snapshot,disconnect_states')
          .in(
            'table_id',
            page.map((capture) => capture.tableId)
          )
          .limit(page.length + 1);
        checkAll();
        const byId = new Map();
        const readable = !error && Array.isArray(data) && data.length <= page.length;
        if (readable) {
          for (const row of data) {
            if (record(row) && uuid(row.table_id) && !byId.has(row.table_id))
              byId.set(row.table_id, row);
          }
        }
        const now = Date.now();
        for (const captured of page) {
          const row = readable ? byId.get(captured.tableId) : undefined;
          const snapshot = row?.time_bank_snapshot;
          const parkedAt = typeof row?.parked_at === 'string' ? Date.parse(row.parked_at) : NaN;
          const players = record(snapshot) && record(snapshot.players) ? snapshot.players : {};
          // What `loadTimeBanksFromPark` keeps: a uuid key and a restorable bank.
          // Anything else it skipped when this engine read the row, and the
          // successor will skip it again; an entry it would KEEP that this
          // engine does not hold is a bank the engine lost, and is not proof.
          const restorable = (userId, bank) =>
            uuid(userId) &&
            validBank(bank) &&
            (bank.unlimitedActivations === undefined ||
              typeof bank.unlimitedActivations === 'boolean');
          const extra = Object.keys(players).filter(
            (userId) => !Object.hasOwn(captured.banks, userId)
          );
          const moved = Object.keys(captured.banks).find(
            (userId) => canonical(players[userId]) !== canonical(captured.banks[userId])
          );
          const kept = extra.find((userId) => restorable(userId, players[userId]));
          const checks = [
            ['read', () => readable],
            ['row.present', () => record(row)],
            ['row.parked_at', () => Number.isFinite(parkedAt) && parkedAt <= now],
            ['snapshot.shape', () =>
              record(snapshot) &&
              Object.keys(snapshot).sort().join(',') === 'handNumber,parkedAt,players,version' &&
              snapshot.version === 1 &&
              typeof snapshot.parkedAt === 'string' &&
              Date.parse(snapshot.parkedAt) === parkedAt &&
              record(snapshot.players)],
            ['snapshot.handNumber', () => snapshot.handNumber === captured.handNumber],
            ['snapshot.players', () => moved === undefined],
            ['snapshot.extraPlayers', () => kept === undefined],
            ['row.disconnect_states', () =>
              record(row.disconnect_states) &&
              Object.values(row.disconnect_states).every(record)],
            // The write would have left an EMPTY presence for a stopped engine.
            // The row may keep one only if the successor will not read it.
            ['row.presence', () =>
              Object.keys(row.disconnect_states).length === 0 ||
              now - parkedAt > parkedPresenceFreshMs],
          ];
          let failed = null;
          for (const [name, evaluate] of checks) {
            let holds = false;
            try {
              holds = evaluate() === true;
            } catch {
              holds = false;
            }
            if (!holds) {
              failed = name;
              break;
            }
          }
          if (failed === null) {
            rowProvedCustody.add(captured.tableId);
            provedDetail.push(
              `${String(captured.tableId).slice(0, 8)}:${describe(
                captured.engine.engineLeaseScope
              )}:banks=${Object.keys(captured.banks).length}:extra=${extra.length}:states=${
                Object.keys(row.disconnect_states).length
              }:age=${Math.round((now - parkedAt) / 60000)}m`
            );
          } else {
            rowUnproven.set(captured.tableId, failed);
          }
        }
      }
      if (candidates.length > 0) {
        const scopes = new Map();
        for (const capture of candidates) {
          if (!rowProvedCustody.has(capture.tableId)) continue;
          const scope = describe(capture.engine.engineLeaseScope);
          scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
        }
        provedRows = `tables=${rowProvedCustody.size}/${candidates.length} ${[...scopes]
          .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
          .map(([scope, count]) => `${scope}=${count}`)
          .join(' ')} ${[...rowUnproven]
          .map(([tableId, failed]) => `${String(tableId).slice(0, 8)}:unproven=${failed}`)
          .join(' ')} ${provedDetail.join(' ')}`
          .replace(/ {2,}/g, ' ')
          .slice(0, 512);
      }
    }
    stage = 'checkpoint';
    progress('checkpoint');
    let next = 0;
    const run = async () => {
      while (reason === null && next < captures.length) {
        const captured = captures[next++];
        try {
          checkMaintenance();
          checkEngine(captured);
          if (!captured.requiresRow) continue;
          if (rowProvedCustody.has(captured.tableId)) continue;
          captured.writeStartedAt = Date.now();
          attemptedTables++;
          progress();
          const operation = captured.engine.persistPresenceForRestart('parked');
          // The native method synchronously installs this exact queue tail before
          // its first await. A later announcement/park replaces it and is refused.
          captured.presenceSave = captured.engine.presenceSave;
          await operation;
          completedCalls++;
          progress();
          captured.writeEndedAt = Date.now();
          checkMaintenance();
          checkEngine(captured);
          // The same condition and the same code as before; this names the
          // table whose write the engine did not confirm, which the process-wide
          // require never did (run 36061780372 refused 83 tables and named none).
          witness(
            'native_checkpoint_unconfirmed',
            [['engine.parkedBankSaveComplete', () => captured.engine.parkedBankSaveComplete === true]],
            () => ({
              failedTable: captured.tableId,
              observedDetail: [
                `stopped=${captured.stopped}`,
                `scope=${describe(captured.engine.engineLeaseScope)}`,
                `banks=${Object.keys(captured.banks).length}`,
                `states=${Object.keys(captured.states).length}`,
                `deferred=${String(deferredUnresolvableCustody.get(captured.tableId) ?? 'none')}`,
                `rowProof=${rowUnproven.get(captured.tableId) ?? 'not_asked'}`,
                `durability=${describe(captured.engine.maintenanceDurabilityReason?.() ?? 'unknown')}`,
              ].join(','),
            })
          );
        } catch {
          if (reason === null) reason = 'native_checkpoint_failed';
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, captures.length) }, run));
    if (reason !== null) return result(false);
    checkAll();

    stage = 'readback';
    progress('readback');
    const written = captures.filter(
      (capture) => capture.requiresRow && !rowProvedCustody.has(capture.tableId)
    );
    for (let offset = 0; offset < written.length; offset += readPageSize) {
      checkAll();
      const page = written.slice(offset, offset + readPageSize);
      const { data, error } = await modules.client.supabase
        .from('engine_presence_parked')
        .select('table_id,engine_instance,parked_at,time_bank_snapshot,disconnect_states')
        .in(
          'table_id',
          page.map((capture) => capture.tableId)
        )
        .limit(page.length + 1);
      require(!error &&
        Array.isArray(data) &&
        data.length === page.length, 'checkpoint_readback_incomplete');
      const byId = new Map();
      for (const row of data) {
        require(record(row) &&
          uuid(row.table_id) &&
          !byId.has(row.table_id), 'checkpoint_readback_shape');
        byId.set(row.table_id, row);
      }
      for (const captured of page) {
        const row = byId.get(captured.tableId);
        const snapshot = row?.time_bank_snapshot;
        const parkedAt = typeof row?.parked_at === 'string' ? Date.parse(row.parked_at) : NaN;
        require(record(row) &&
          row.engine_instance === `${options.expectedInstanceId}:parked` &&
          Number.isFinite(parkedAt) &&
          parkedAt >= captured.writeStartedAt &&
          parkedAt <= captured.writeEndedAt &&
          record(snapshot) &&
          Object.keys(snapshot).sort().join(',') === 'handNumber,parkedAt,players,version' &&
          snapshot.version === 1 &&
          snapshot.handNumber === captured.handNumber &&
          typeof snapshot.parkedAt === 'string' &&
          Date.parse(snapshot.parkedAt) === parkedAt &&
          canonical(snapshot.players) === canonical(captured.banks) &&
          record(row.disconnect_states) &&
          canonical(Object.keys(row.disconnect_states).sort()) ===
            canonical(Object.keys(captured.states).sort()) &&
          Object.values(row.disconnect_states).every(record), 'checkpoint_readback_mismatch');
        verifiedTables++;
        progress();
      }
      checkAll();
    }
    if (retained8825) {
      // Order is load-bearing: the row proof comes first, and a refusal there
      // means nothing was retired and no custody was transferred.
      progress('proveAbandonedBoundaries');
      await proveAbandonedBoundaries(checkAll);
      progress('sealAndRetireOriginals');
      await sealAndRetireOriginals(checkAll);
    }
    verifyFiles();
    checkAll();
    /* The same condition and the same code as the process-wide require this
       replaces, per table, naming the table and the engine's own reason. A
       dead generation whose row was proved above is the ONE admitted
       exception, and only for the ONE reason its unwritten park produces on
       8825 (`maintenanceDurabilityReason`: `parkedTimeBanks` non-empty and
       `parkedBankSaveComplete` false -> `bank_park_write_incomplete`). Every
       other reason, on every other table, refuses exactly as before; the
       process's own `readyForRestart()` never counted a stopped engine's
       durability at all (8825 `unparkedTables`: `if (!engine.isRunning())
       continue`), so nothing this admits is something the engine refused. */
    for (const captured of captures) {
      const durable = captured.engine.isMaintenanceStateDurable() === true;
      if (durable) continue;
      const durability = captured.engine.maintenanceDurabilityReason?.() ?? 'unknown';
      witness(
        'native_readiness_refused',
        [['engine.isMaintenanceStateDurable', () =>
          rowProvedCustody.has(captured.tableId) &&
          captured.stopped === true &&
          durability === 'bank_park_write_incomplete']],
        () => ({
          failedTable: captured.tableId,
          observedDetail: [
            `durability=${describe(durability)}`,
            `stopped=${captured.stopped}`,
            `scope=${describe(captured.engine.engineLeaseScope)}`,
            `banks=${Object.keys(captured.banks).length}`,
            `rowProved=${rowProvedCustody.has(captured.tableId)}`,
            `deferred=${String(deferredUnresolvableCustody.get(captured.tableId) ?? 'none')}`,
          ].join(','),
        })
      );
    }
    /* THE SAME TRAP, ONE LEVEL UP (CLAUDE.md 10.86 rule 4). The engine's own
       `readyForRestart()` is asked first and is still the authority. On a
       predecessor whose `unparkedTables()` has no bound - 8825af51 is one, and
       it is what production runs - a single unresolved preparation holds that
       boolean false for ever, so admitting the permit in `captureEngine` and
       then refusing on the same fact here would have moved the wedge rather
       than removed it. The fallback below is the identical three-witness rule
       the release transaction already applies to the same boolean, and it can
       only be satisfied by tables the rows proved quiet above. */
    require(maintenance.readyForRestart() === true ||
      restartHeldOnlyByProvenUnresolvableCustody(), 'native_readiness_refused');
    const remaining = checkAll();
    stage = 'complete';
    progress('complete');
    return result(true, remaining);
  } catch {
    if (reason === null) reason = 'guard_failed';
    return result(false);
  }
}
