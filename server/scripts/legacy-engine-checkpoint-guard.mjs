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
 * certificate and >=260000ms reserve before stopping the process: the transaction
 * admits the checkpoint only while >=285000ms remain (its entry slack), and the
 * publisher's bounded work (workBudgetMs 20000 + cleanupBudgetMs 5000 = 25 s) is
 * paid out of the candidate-proof budget, so 285 - 25 = 260 seconds is the exact
 * figure engine-release-transaction.sh accepts on the certificate it reads after
 * a legacy checkpoint (LEGACY_MIN_BREAK_REMAINING_MS). The 135-second rollback
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
  const reserveMs = 260000;
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
  let unstartedReplacements = 0;
  let unstartedDepartures = 0;
  const refuse = (code) => {
    if (reason === null) reason = code;
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
    ...(retained8825 ? { skippedUnstarted, unstartedReplacements, unstartedDepartures } : {}),
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
        const exactEngines = originals.map(([tableId, engine]) => {
          require(uuid(tableId) &&
            !retained.has(engine) &&
            tableMap.get(tableId) === engine &&
            ownedTables.has(tableId) &&
            manager.tableEngines.get(tableId) === engine &&
            engine instanceof modules.base.ServerTableEngineBase &&
            engine.tableId === tableId, 'mixed_original_registry_disagreement');
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
                ...(name === 'terminalBoundaryPendingGenerations'
                  ? { failedPermitPhase: capture.phase === null ? 'none' : capture.phase }
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
            () => ({
              failedTournament: capturedTournamentId,
              failedMap: failedMap(),
              failedSet: failedSet(),
              failedTable: failedEngine(),
              observed: describe(manager.tournamentLeaseGeneration),
              expected: describe(capturedLeaseGeneration),
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
      for (const capture of retainedManagers) {
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
          require(!response.error &&
            record(response.data) &&
            response.data.ok === true, 'mixed_custody_rpc_unknown');
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
          require(witness.allocation_epoch === original.allocationEpoch &&
            typeof witness.lifecycle === 'string' &&
            /^[1-9][0-9]{0,18}$/.test(witness.lifecycle) &&
            (original.lifecycle === null || original.lifecycle === witness.lifecycle) &&
            Array.isArray(witness.permits) &&
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
            ), 'mixed_original_lifecycle_evidence_invalid');
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
        require(record(capture.receipt), 'mixed_custody_receipt_missing');
        for (const { tableId, engine } of capture.exactEngines) {
          checkAll();
          require(server.unregisterTournamentTableEngine(tableId, engine) ===
            true, 'mixed_original_retirement_cas_refused');
          retiredOriginals.add(tableId);
          checkAll();
        }
      }
    }

    const captureEngine = (tableId, engine) => {
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
        require(engine.f06CurrentPermit === null &&
          engine.f06RecoveryInFlight === false, 'f06_custody_not_drained');
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
        engine.terminalBoundaryPendingGenerations.size === 0 &&
        engine.terminalBoundaryPersistenceFailed === false, 'engine_work_not_drained');
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
      for (const [key, bank] of engine.timeBankEngine.playerBanks) {
        require(record(bank) &&
          bank.tableId === tableId &&
          uuid(bank.playerId) &&
          key === `${tableId}:${bank.playerId}` &&
          seats.has(bank.playerId), 'bank_occupancy_mismatch');
      }
      for (const userId of engine.timeBankMeta.keys()) {
        require(seats.has(userId) &&
          engine.timeBankEngine.playerBanks.has(
            `${tableId}:${userId}`
          ), 'bank_metadata_without_bank');
      }
      const expectedBanks = {};
      for (const [userId, bank] of Object.entries(engine.parkedTimeBanks)) {
        require(uuid(userId) &&
          validBank(bank) &&
          seats.get(userId)?.occupancy_id === bank.occupancyId, 'parked_bank_invalid');
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
        require(engine.timeBankMeta.size === 0 &&
          engine.timeBankEngine.playerBanks.size === 0 &&
          Object.keys(engine.parkedTimeBanks).length === 0 &&
          Object.keys(states).length === 0, 'stopped_engine_retains_custody');
      }
      const signature = canonical({
        handNumber: engine.handCount,
        roster: engine.seatedPlayers.map((seat) => [
          seat.user_id,
          seat.occupancy_id ?? null,
          seat.seat_number,
          seat.stack,
        ]),
        banks: expectedBanks,
        states,
      });
      return {
        tableId,
        engine,
        methods,
        authority,
        stopped,
        teardown: engine.teardownPromise,
        handNumber: engine.handCount,
        banks: expectedBanks,
        states,
        signature,
        uninitialized,
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
      captures.push(captureEngine(id, engine));
    }
    const checkEngine = (captured) => {
      require(tableMap.get(captured.tableId) === captured.engine, 'engine_identity_changed');
      const current = captureEngine(captured.tableId, captured.engine);
      require(current.authority === captured.authority &&
        current.stopped === captured.stopped &&
        current.teardown === captured.teardown &&
        current.methods.every(
          (method, index) => method === captured.methods[index]
        ), 'engine_method_changed');
      require(current.pause === captured.pause &&
        current.timer === captured.timer &&
        current.bankEngine === captured.bankEngine &&
        current.bankMeta === captured.bankMeta &&
        current.signature === captured.signature, 'engine_state_changed');
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

    // Join the existing announcement/native park writes before taking the final
    // baseline. Pointer equality refuses any newly admitted presence writer.
    const previousWork = await Promise.allSettled(
      captures.flatMap((capture) =>
        capture.stopped ? [capture.presenceSave, capture.teardown] : [capture.presenceSave]
      )
    );
    require(previousWork.every(
      (entry) => entry.status === 'fulfilled'
    ), 'previous_native_work_unconfirmed');
    checkAll();
    bankCount = captures.reduce((sum, capture) => sum + Object.keys(capture.banks).length, 0);
    uninitializedSeats = captures.reduce((sum, capture) => sum + capture.uninitialized, 0);
    stage = 'checkpoint';
    let next = 0;
    const run = async () => {
      while (reason === null && next < captures.length) {
        const captured = captures[next++];
        try {
          checkMaintenance();
          checkEngine(captured);
          if (!captured.requiresRow) continue;
          captured.writeStartedAt = Date.now();
          attemptedTables++;
          const operation = captured.engine.persistPresenceForRestart('parked');
          // The native method synchronously installs this exact queue tail before
          // its first await. A later announcement/park replaces it and is refused.
          captured.presenceSave = captured.engine.presenceSave;
          await operation;
          completedCalls++;
          captured.writeEndedAt = Date.now();
          checkMaintenance();
          checkEngine(captured);
          require(captured.engine.parkedBankSaveComplete === true, 'native_checkpoint_unconfirmed');
        } catch {
          if (reason === null) reason = 'native_checkpoint_failed';
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, captures.length) }, run));
    if (reason !== null) return result(false);
    checkAll();

    stage = 'readback';
    const written = captures.filter((capture) => capture.requiresRow);
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
          canonical(row.disconnect_states) ===
            canonical(captured.states), 'checkpoint_readback_mismatch');
        verifiedTables++;
      }
      checkAll();
    }
    if (retained8825) {
      // Order is load-bearing: the row proof comes first, and a refusal there
      // means nothing was retired and no custody was transferred.
      await proveAbandonedBoundaries(checkAll);
      await sealAndRetireOriginals(checkAll);
    }
    verifyFiles();
    checkAll();
    require(captures.every(({ engine }) => engine.isMaintenanceStateDurable() === true) &&
      maintenance.readyForRestart() === true, 'native_readiness_refused');
    const remaining = checkAll();
    stage = 'complete';
    return result(true, remaining);
  } catch {
    if (reason === null) reason = 'guard_failed';
    return result(false);
  }
}
