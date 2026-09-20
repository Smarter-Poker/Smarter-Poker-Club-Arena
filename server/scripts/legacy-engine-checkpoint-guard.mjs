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
 * certificate and >=285000ms reserve before stopping the process. Success below is
 * a checked instant, not a new lock, a freeze extension, or a substitute certificate.
 */
export async function legacyEngineCheckpointGuard(options, discoveredServers, modules) {
  const release = options?.expectedReleaseSha;
  const retained8825 = release === '8825af51817f379c4261658ca29ecc9d8d81932d';
  const trackedAccounting =
    retained8825 ||
    release === '758610f3f844406bbbaee2f5100ced36d84fb943' ||
    release === 'a0ab287d902879280f0c915e44f5222c5db4d7df';
  const reserveMs = 285000;
  // Refusal ceilings, not truncation or latency promises. The observed fleet has
  // 1379 tables, so the ordinary PostgREST 1000-row cap cannot bound the fleet.
  const maxTables = 2000;
  const maxEntriesPerTable = 64;
  const concurrency = 32;
  const readPageSize = 100;
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
  const refuse = (code) => {
    if (reason === null) reason = code;
    throw new Error('legacy_checkpoint_refused');
  };
  const require = (condition, code) => {
    if (!condition) refuse(code);
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
    const retainedManagers = [];
    let checkRetained = () => {};
    const engines = new Set();
    const tableIds = new Set();
    const captures = [];
    const base = modules.base.ServerTableEngineBase.prototype;
    const checkMaintenance = () => {
      // This bridge originates at process scope. Existing tournament-engine
      // wrappers enter their own authority; never unwrap/rebind those methods or
      // inherit one tournament's actor for another table or the fleet readback.
      require(modules.dataActorContext.currentTournamentDataAuthority() ===
        null, 'unexpected_tournament_context');
      require(server.running === true &&
        server.teardownPromise === null &&
        server.lifecycleGeneration === serverGeneration &&
        server.tableEngines === tableMap &&
        server.maintenanceBreak === maintenance, 'server_changed');
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
      require(tableMap.size === entries.length - retiredOriginals.size &&
        entries.every(([id, engine]) =>
          retiredOriginals.has(id) ? !tableMap.has(id) : tableMap.get(id) === engine
        ), 'fleet_identity_changed');
      checkRetained();
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
        const revision = manager.tournamentSeatMoveAuthorityRevision;
        const serial = manager.tournamentSeatMoveSerialTail;
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
          require(engine.running === false &&
            engine.terminal === true &&
            engine.terminalTeardownComplete === true &&
            engine.hasReleasedProcessOwnership() === true &&
            !modules.base.ServerTableEngineBase.liveEngines.has(tableId) &&
            engine.dealingLoopPromise === null &&
            engine.postHandTasksPromise === null &&
            engine.snapshotFlushPromise === null &&
            engine.handController === null &&
            engine.actionLock === false &&
            engine.f06HandPreparation === null &&
            engine.f06RecoveryInFlight === false &&
            engine.terminalBoundaryPersistenceFailed === false &&
            engine.timeBankAccountingUnconfirmed === false &&
            engine.engineLeaseScope === 'tournament' &&
            engine.engineLeaseVerified === true &&
            engine.engineLeaseTournamentId === manager.tournamentId &&
            engine.engineLeaseGeneration === manager.tournamentLeaseGeneration &&
            engine.f06AllocationEpoch === capture.allocationEpoch &&
            [engine.f06Allocator, engine.f06AllocationCurrent, engine.f06PermitFactory].every(
              (method, index) => method === capture.allocation[index]
            ) &&
            engine.f06MovementAdmission === capture.movementAdmission &&
            engine.f06CurrentPermit === permit &&
            permit?.binding === capture.permitBinding &&
            (permit?.recoveryState() ?? null) === capture.phase &&
            (permit === null ||
              (permit.reserveInFlight === false &&
                permit.preparedCancellation === false &&
                permit.recoveryState === modules.permit.F06HandPermit.prototype.recoveryState)) &&
            serialFields.every((name, index) => engine[name] === capture.queues[index]) &&
            [engine.hasReleasedProcessOwnership, engine.hasOnlyDrainedTournamentMoveOwner].every(
              (method, index) => method === capture.methods[index]
            ) &&
            engine.hasOnlyDrainedTournamentMoveOwner(manager.tournamentMoveBoundaryOwner) ===
              true, 'mixed_original_work_not_drained');
          [...engineSets, ...engineMaps].forEach((name, index) => {
            const collection = engine[name];
            require(collection === capture.collections[index] &&
              collection.size === 0 &&
              (engineSets.includes(name)
                ? collection instanceof Set
                : collection instanceof Map), 'mixed_original_work_not_drained');
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
          require(server.tournamentEngines === managerMap &&
            managerMap.get(manager.tournamentId) === manager &&
            server.tournamentRetirementCustody === retirement &&
            server.tournamentOwnedTables === ownedTables &&
            server.unregisterTournamentTableEngine === unregister &&
            manager.gameServer === server &&
            manager.captureDrainedF06Originals === captureMethod &&
            manager.captureDrainedF06Originals() === originals &&
            manager.pendingTableBreakRetirement === exactRetirement &&
            manager.tournamentSeatMoveAuthorityRevision === revision &&
            manager.tournamentSeatMoveSerialTail === serial &&
            manager.activeStoppedOriginalCustody.size === 0 &&
            Object.entries(exactMaps).every(
              ([name, map]) =>
                manager[name] === map &&
                map.size === exactMapEntries[name].length &&
                exactMapEntries[name].every(([key, value]) => map.get(key) === value)
            ) &&
            Object.entries(exactSets).every(
              ([name, set]) => manager[name] === set && set.size === 0
            ) &&
            exactEngines.every(
              ({ tableId, engine }) =>
                manager.tableEngines.get(tableId) === engine &&
                (retiredOriginals.has(tableId)
                  ? !tableMap.has(tableId) && !ownedTables.has(tableId)
                  : tableMap.get(tableId) === engine && ownedTables.has(tableId))
            ), 'mixed_owner_changed');
          return vector();
        };
        pending.push({ manager, proposal, exactEngines, vector, current, initial, serial });
      }
      checkRetained = () => {
        for (const capture of pending)
          require(canonical(capture.current()) === capture.initial, 'mixed_local_custody_changed');
      };
      checkMaintenance();
      const joined = await Promise.allSettled(
        pending.flatMap((m) => [m.serial, ...m.exactEngines.flatMap((e) => e.queues)])
      );
      require(joined.every((v) => v.status === 'fulfilled'), 'mixed_original_stop_unconfirmed');
      checkMaintenance();
      const ids = pending.flatMap((m) => m.exactEngines.map((e) => e.tableId));
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
          if (initialized) {
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
          if (['unknown', 'reserved', 'terminated'].includes(item.permit.phase)) {
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
    for (const [id, engine] of entries) {
      if (retainedEngines.has(engine)) continue;
      require(!engines.has(engine), 'engine_not_unique');
      require(uuid(id) && !tableIds.has(id.toLowerCase()), 'engine_identity_mismatch');
      tableIds.add(id.toLowerCase());
      engines.add(engine);
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
    if (retained8825) await sealAndRetireOriginals(checkAll);
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
