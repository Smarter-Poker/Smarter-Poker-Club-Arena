/**
 * Three exact-image first-install checkpoint profiles. This function has no module-scoped
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
 * checkpoint generation unchanged. Neither claims historical reconciliation or
 * restart approval, and neither may settle or discard retained F06 custody.
 *
 * A disconnected/expired caller must retain an UNKNOWN operation, never retry it.
 * Started native writes are joined even after refusal; an RPC timeout remains an
 * ambiguous remote outcome. The existing publisher must freshly verify its native
 * certificate and >=285000ms reserve before stopping the process. Success below is
 * a checked instant, not a new lock, a freeze extension, or a substitute certificate.
 */
export async function legacyEngineCheckpointGuard(options, discoveredServers, modules) {
  const release = options?.expectedReleaseSha;
  const trackedAccounting = release === '758610f3f844406bbbaee2f5100ced36d84fb943' ||
    release === 'a0ab287d902879280f0c915e44f5222c5db4d7df';
  const reserveMs = 285000;
  // Refusal ceilings, not truncation or latency promises. The observed fleet has
  // 1379 tables, so the ordinary PostgREST 1000-row cap cannot bound the fleet.
  const maxTables = 2000;
  const maxEntriesPerTable = 64;
  const concurrency = 32;
  const readPageSize = 100;
  const filePins = trackedAccounting ? [
    ['/app/dist/GameServer.js', 'f8a4e646348fbd0209b9afde24658660dca0837f7720e04b47d37cff4fa2bea7'],
    ['/app/dist/engine/ServerTableEngineBase.js', 'cc715650eca1b6cfbccadcef46a9f07f581549e75df6581cb8c32f3fbfffc0b3'],
    ['/app/dist/services/supabase/client.js', 'f129642e3ce48e26a84f3f7fa60c46d3ceabd67e35f0508c1711319bc95f56ad'],
    ['/app/dist/engine/ServerTableEngineDealing.js', release === 'a0ab287d902879280f0c915e44f5222c5db4d7df'
      ? 'a15d068c8a43ab0c34a208abf4380815813cf71a703978e334ed5c78ef70788b'
      : '44a7c52ede31dd3a5600d6b648b0d34c9ecabc3e10f14a65830712b432dc62e9'],
  ] : [
    ['/app/dist/GameServer.js', 'bfcb47c498c34408dd95047e90535c7ddc1ecc5fef14e41e1063ec72a1aad119'],
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
      : attemptedTables > 0
        ? 'unconfirmed'
        : 'not_started',
    paidAccountingQualification: trackedAccounting
      ? (ok ? 'native_pending_registry_drained' : 'native_pending_registry_unqualified')
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
      require(tableMap.size === entries.length &&
        entries.every(([id, engine]) => tableMap.get(id) === engine), 'fleet_identity_changed');
      return remaining;
    };
    checkMaintenance();

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
        };
        require(validBank(saved) &&
          Object.keys(saved).sort().join(',') ===
            'baseSeconds,dbConsumedSeconds,initialSeconds,occupancyId,remainingSeconds,usesRemaining', 'bank_not_restorable');
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
    for (const [id, engine] of entries) {
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
        current.checkpointGeneration === captured.checkpointGeneration, 'native_checkpoint_owner_changed');
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
