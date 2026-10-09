/**
 * The owning, exact-image checkpoint transport supplies real cached modules and
 * singleton objectIds. This function is serialized, so all dependencies are
 * explicit. It does not open an inspector, certify a break, stop a process or
 * retry an RPC. An installed live fence is NOT proof of a safe pre-node boot.
 * `rollback-boot` is installed by the owning preload before original index.js.
 */
export async function operatorHoldCheckpointGuard(options, servers, modules, httpServer) {
  const demand = (value, code) => {
    if (!value) throw new Error(`operator_hold_guard:${code}`);
  };
  const uuid = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const boot = options?.mode === 'rollback-boot';
  const resuming = options?.mode === 'resume-first-upgrade';
  const firstUpgrade = options?.mode === 'first-upgrade';
  demand(boot || resuming || ['first-upgrade', 'rollback'].includes(options?.mode), 'mode');
  // This is a single first-upgrade/rollback profile, not a generic inspector gate.
  demand(
    uuid(options.handoffId) &&
      options.expectedReleaseSha === '94b2ae91c3c6742b5e05bca858c62580651ee180' &&
      options.expectedPid === process.pid &&
      options.expectedInstanceId === modules?.tableLease?.INSTANCE_ID &&
      modules?.releaseIdentity?.ENGINE_RELEASE_IDENTITY?.releaseSha === options.expectedReleaseSha,
    'identity'
  );
  const base = modules?.base?.ServerTableEngineBase?.prototype;
  const seating = modules?.seating?.ServerTableEngineSeating?.prototype;
  const dealing = modules?.dealing?.ServerTableEngineDealing?.prototype;
  demand(
    base &&
      seating &&
      typeof base.start === 'function' &&
      typeof seating.adminPause === 'function' &&
      typeof seating.adminResume === 'function' &&
      typeof modules?.client?.supabase?.rpc === 'function' &&
      typeof modules?.http?.Server === 'function' &&
      typeof base.isNextHandPaused === 'function' &&
      typeof base.resumeFromMaintenance === 'function' &&
      typeof base.resumeDealing === 'function' &&
      typeof dealing?.dealHand === 'function',
    'modules'
  );
  const token = Symbol.for('smarter.operator-hold-checkpoint.v1');
  if (resuming) {
    const retained = this?.[token];
    demand(
      retained &&
        retained.mode === 'first-upgrade' &&
        retained.rpcStarted === true &&
        retained.handoffId === options.handoffId &&
        retained.sourceInstance === options.expectedInstanceId &&
        retained.sourceRelease === options.expectedReleaseSha &&
        retained.pid === process.pid &&
        [
          'gameServer',
          'base',
          'seating',
          'dealing',
          'managerBase',
          'releaseIdentity',
          'tableLease',
          'client',
          'http',
        ].every((key) => retained.modules[key] === modules[key]) &&
        retained.httpServer === httpServer &&
        Array.isArray(servers) &&
        servers.length === 1 &&
        servers[0] === this &&
        Object.getPrototypeOf(this) === modules.gameServer?.GameServer?.prototype &&
        typeof retained.resume === 'function',
      'resume_identity'
    );
    demand(
      Number.isFinite(options.proofDeadline) &&
        Date.now() < options.proofDeadline &&
        options.proofDeadline <= Date.now() + 20000 &&
        this.maintenanceBreak?.readyForRestart?.() === true,
      'maintenance_boundary'
    );
    demand(this.maintenanceBreak.snapshot?.().remainingMs >= 245000, 'rollback_reserve');
    demand(!retained.resuming && !retained.importInFlight, 'resume_in_progress');
    retained.resuming = true;
    try {
      return await retained.resume(options.proofDeadline);
    } finally {
      retained.resuming = false;
    }
  }
  const host = boot ? base : this;
  const inheritedBoot = !boot && options.mode === 'rollback' ? base[token] : null;
  demand(host && !host[token] && (!base[token] || inheritedBoot), 'already_installed');
  if (!boot) {
    demand(
      Array.isArray(servers) &&
        servers.length === 1 &&
        servers[0] === this &&
        Object.getPrototypeOf(this) === modules.gameServer?.GameServer?.prototype,
      'server_singleton'
    );
    demand(
      Number.isFinite(options.proofDeadline) &&
        Date.now() < options.proofDeadline &&
        this.maintenanceBreak?.readyForRestart?.() === true,
      'maintenance_boundary'
    );
    demand(httpServer?.listening && Number(httpServer.address()?.port) === 8080, 'http_port');
    demand(this.maintenanceBreak.snapshot?.().remainingMs >= 245000, 'rollback_reserve');
  }
  demand(
    !inheritedBoot ||
      (inheritedBoot.handoffId === options.handoffId &&
        inheritedBoot.base === base &&
        inheritedBoot.seating === seating),
    'boot_identity'
  );
  const state = inheritedBoot ?? {
    handoffId: options.handoffId,
    mode: options.mode,
    phase: 'installing',
    rpcStarted: false,
    base,
    seating,
    sourceInstance: options.expectedInstanceId,
    sourceRelease: options.expectedReleaseSha,
    pid: process.pid,
    modules: { ...modules },
    httpServer,
  };
  if (!boot) state.liveRestorationPending = options.mode === 'rollback';
  Object.defineProperty(host, token, { value: state, configurable: false });
  const fenced = state.fenced ?? new WeakMap();
  state.fenced = fenced;
  const originals = [];
  const protectedEngines = new Set();
  const refuse = () => {
    throw new Error('operator_hold_guard:operator_commands_unavailable');
  };
  const replace = (object, key, value) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    demand(
      (!descriptor || descriptor.configurable) && typeof object[key] === 'function',
      `method_${key}`
    );
    Object.defineProperty(object, key, {
      configurable: true,
      writable: true,
      enumerable: descriptor?.enumerable ?? false,
      value,
    });
    originals.push([object, key, descriptor, value]);
  };
  const bindEngine = (engine) => {
    demand(engine instanceof modules.base.ServerTableEngineBase && uuid(engine.tableId), 'engine');
    if (fenced.has(engine)) return;
    const descriptor = Object.getOwnPropertyDescriptor(engine, 'adminPauseLock');
    demand(
      descriptor && descriptor.configurable && typeof descriptor.value === 'boolean',
      'hold_shape'
    );
    // Outgoing memory IS the authority being captured. An uncertain import
    // must not prolong its maintenance break or pretend that authority is lost.
    const hold = { value: descriptor.value, restored: firstUpgrade };
    fenced.set(engine, hold);
    protectedEngines.add(engine);
    Object.defineProperty(engine, 'adminPauseLock', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => hold.value,
      set: refuse,
    });
    originals.push([engine, 'adminPauseLock', descriptor, null]);
    // Tournament methods already bound to their data authority capture the old
    // prototype function. Fence those own methods too, and the flag itself.
    for (const name of ['adminPause', 'adminResume']) {
      if (Object.hasOwn(engine, name)) replace(engine, name, refuse);
    }
  };
  const lease = (engine) => {
    demand(
      engine.engineLeaseVerified === true &&
        uuid(engine.engineLeaseGeneration) &&
        typeof engine.engineLeaseAuthorityIsCurrent === 'function' &&
        engine.engineLeaseAuthorityIsCurrent(),
      'lease'
    );
    return engine.engineLeaseGeneration;
  };
  const readHold = async (engine, apply = true) => {
    bindEngine(engine);
    const generation = lease(engine);
    const { data, error } = await modules.client.supabase.rpc('fn_ca_get_table_operator_hold', {
      p_table_id: engine.tableId,
    });
    demand(
      !error &&
        data &&
        typeof data.paused === 'boolean' &&
        Number.isSafeInteger(data.version) &&
        data.version >= 0 &&
        (data.command_id === null || uuid(data.command_id)),
      'native_hold_read'
    );
    demand(
      lease(engine) === generation && !engine.terminal && !engine.teardownPromise,
      'read_owner_changed'
    );
    const hold = fenced.get(engine);
    if (apply) {
      hold.value = data.paused;
      hold.restored = true;
    }
    return data;
  };
  const originalStart = base.start;
  if (!inheritedBoot) {
    replace(seating, 'adminPause', refuse);
    replace(seating, 'adminResume', refuse);
    const pauseGate = base.isNextHandPaused;
    replace(base, 'isNextHandPaused', function (...args) {
      const hold = fenced.get(this);
      return (hold && !hold.restored) || pauseGate.apply(this, args);
    });
    // Do not allow a concurrent thaw to pass the async restoration boundary.
    // Once restored, the original methods retain maintenance/HFH ownership.
    for (const name of ['resumeFromMaintenance', 'resumeDealing']) {
      const original = base[name];
      replace(base, name, function (...args) {
        bindEngine(this);
        demand(!state.liveRestorationPending && fenced.get(this).restored, 'hold_not_restored');
        return original.apply(this, args);
      });
    }
    const deal = dealing.dealHand;
    replace(dealing, 'dealHand', async function (...args) {
      bindEngine(this);
      demand(
        !state.liveRestorationPending && fenced.get(this).restored && !fenced.get(this).value,
        'hold_not_restored_or_held'
      );
      return await deal.apply(this, args);
    });
    replace(base, 'start', async function (...args) {
      bindEngine(this);
      if (firstUpgrade) {
        this.settleReady?.(false);
        throw new Error('operator_hold_guard:outgoing_admission_fenced');
      }
      try {
        await readHold(this);
        return await originalStart.apply(this, args);
      } catch (error) {
        this.settleReady?.(false);
        throw error;
      }
    });
  }
  const listenerServers = state.listenerServers ?? new WeakSet();
  state.listenerServers = listenerServers;
  const bindHttp = (server) => {
    demand(server instanceof modules.http.Server, 'http_identity');
    if (listenerServers.has(server)) return;
    const listeners = server.rawListeners('request');
    demand(
      listeners.length === 1 && server.listeners('request')[0] === listeners[0],
      'request_listener'
    );
    const original = listeners[0];
    const guarded = function (request, response) {
      // Preserve the original router's pathname convention, including query.
      const pathname = String(request.url ?? '').split('?')[0];
      if (request.method === 'POST' && ['/admin/pause', '/admin/resume'].includes(pathname)) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ success: false, error: 'operator_commands_unavailable' }));
        return;
      }
      return original.call(this, request, response);
    };
    server.removeListener('request', original);
    server.on('request', guarded);
    listenerServers.add(server);
    state.httpBound = true;
    state.requestListener = guarded;
    originals.push([server, 'request', original, guarded]);
  };
  if (boot) {
    // Construction boundary, not a timer/listening observer: replace the sole
    // original router before the exact 8080 server can accept its first request.
    const prototype = modules.http.Server.prototype;
    const originalListen = prototype.listen;
    replace(prototype, 'listen', function (...args) {
      const port = typeof args[0] === 'object' ? args[0]?.port : args[0];
      if (Number(port) === 8080) {
        demand(!state.httpBound && !this.listening, 'boot_http_not_unique');
        bindHttp(this);
      }
      return originalListen.apply(this, args);
    });
    state.phase = 'boot_fence_installed';
    return { ok: true, phase: state.phase, handoffId: state.handoffId, bootQualified: false };
  }
  bindHttp(httpServer);
  const census = (existingOnly = false) => {
    const found = new Set();
    const add = (engine) => {
      demand(!existingOnly || fenced.has(engine), 'fleet_changed');
      bindEngine(engine);
      found.add(engine);
    };
    const pairs = (map) => {
      demand(map instanceof Map, 'fleet_map');
      for (const [id, engine] of map) {
        demand(uuid(id) && id === engine.tableId, 'fleet_key');
        add(engine);
      }
    };
    pairs(this.tableEngines);
    demand(
      this.tournamentEngines instanceof Map &&
        this.tournamentDiagnosticRetirements instanceof Map &&
        this.drainedF06TournamentCustody instanceof Map &&
        this.completedF06TournamentCustody instanceof Map,
      'manager_maps'
    );
    const managers = new Set(this.tournamentEngines.values());
    for (const retired of this.tournamentDiagnosticRetirements.values()) {
      demand(retired instanceof Set, 'retired_managers');
      for (const manager of retired) managers.add(manager);
    }
    const packet = (item) => {
      demand(item && item.manager && Array.isArray(item.engines), 'custody_packet');
      managers.add(item.manager);
      for (const pair of item.engines) {
        demand(Array.isArray(pair) && pair[0] === pair[1]?.tableId, 'custody_pair');
        add(pair[1]);
      }
    };
    for (const item of this.drainedF06TournamentCustody.values()) packet(item);
    for (const items of this.completedF06TournamentCustody.values()) {
      demand(items instanceof Set, 'completed_packets');
      for (const item of items) packet(item.original);
    }
    for (const manager of managers) {
      demand(manager instanceof modules.managerBase?.TournamentManagerBase, 'manager_identity');
      for (const key of [
        'tableEngines',
        'stoppedDiagnosticOriginals',
        'satelliteQualifierEngines',
        'retainedTournamentBreakSources',
        'pendingNoStartContinuations',
        'stoppedOriginalBreaks',
        'tournamentBreakArrivalWakes',
      ]) {
        const map = manager[key];
        demand(map instanceof Map, `manager_${key}`);
        for (const value of map.values()) {
          if (key === 'tournamentBreakArrivalWakes') {
            demand(value instanceof Map, 'arrival_wakes');
            for (const engine of value.values()) add(engine);
          } else
            add(
              ['retainedTournamentBreakSources', 'pendingNoStartContinuations'].includes(key)
                ? value?.engine
                : value
            );
        }
      }
      demand(
        manager.drainedF06Originals === null || Array.isArray(manager.drainedF06Originals),
        'drained_originals'
      );
      for (const pair of manager.drainedF06Originals ?? []) add(pair[1]);
      if (manager.pendingTableBreakRetirement !== null)
        add(manager.pendingTableBreakRetirement?.engine);
    }
    demand(found.size <= 2000, 'fleet_ceiling'); // Refuse; never truncate.
    return found;
  };
  const engines = census();
  const rows = new Map();
  let retired = 0;
  for (const engine of engines) {
    const released = engine.hasReleasedProcessOwnership?.();
    if (engine.terminal === true && released === true) {
      retired++;
      continue;
    }
    demand(
      released === false &&
        !engine.teardownPromise &&
        !engine.handController &&
        engine.maintenancePaused === true,
      'engine_not_parked'
    );
    const row = {
      table_id: engine.tableId,
      paused: fenced.get(engine).value,
      lease_generation: lease(engine),
    };
    const prior = rows.get(row.table_id);
    demand(
      !prior || (prior.paused === row.paused && prior.lease_generation === row.lease_generation),
      'conflicting_generations'
    );
    rows.set(row.table_id, row);
  }
  const current = [...engines].filter(
    (engine) => !(engine.terminal && engine.hasReleasedProcessOwnership())
  );
  const fleet = [...rows.values()].sort((a, b) => a.table_id.localeCompare(b.table_id));
  state.phase = 'fenced';
  state.fleet = fleet;
  const unchanged = (deadline = options.proofDeadline) => {
    const after = census(true);
    demand(
      after.size === engines.size && [...after].every((engine) => engines.has(engine)),
      'fleet_changed'
    );
    demand(
      Date.now() < deadline && this.maintenanceBreak.readyForRestart() === true,
      'proof_expired'
    );
    demand(this.maintenanceBreak.snapshot?.().remainingMs >= 245000, 'rollback_reserve');
    for (const engine of current) {
      demand(
        lease(engine) === rows.get(engine.tableId).lease_generation &&
          !engine.handController &&
          engine.maintenancePaused === true,
        'boundary_changed'
      );
    }
  };
  unchanged();
  if (firstUpgrade) {
    // Reattach only to this live object's original capture. Never import again.
    const originalFleet = JSON.stringify(fleet);
    state.resume = async (deadline) => {
      unchanged(deadline);
      demand(
        JSON.stringify(state.fleet) === originalFleet &&
          httpServer.listening &&
          Number(httpServer.address()?.port) === 8080 &&
          state.httpBound === true &&
          httpServer.rawListeners('request').length === 1 &&
          httpServer.rawListeners('request')[0] === state.requestListener,
        'resume_capture_changed'
      );
      const { data, error } = await modules.client.supabase.rpc('fn_ca_get_operator_hold_handoff', {
        p_handoff_id: state.handoffId,
      });
      const canonical = (value) =>
        JSON.stringify(value, (_key, item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? Object.fromEntries(
                Object.keys(item)
                  .sort()
                  .map((key) => [key, item[key]])
              )
            : item
        );
      demand(
        !error &&
          data &&
          data.handoff_id === state.handoffId &&
          data.source_instance === state.sourceInstance &&
          data.source_release_sha === state.sourceRelease &&
          canonical(data.fleet) === canonical(fleet),
        'original_import_unknown'
      );
      for (let offset = 0; offset < current.length; offset += 32) {
        const results = await Promise.allSettled(
          current.slice(offset, offset + 32).map((engine) => readHold(engine, false))
        );
        for (const [index, result] of results.entries()) {
          demand(result.status === 'fulfilled', 'hold_readback_unknown');
          const engine = current[offset + index];
          demand(
            result.value.paused === rows.get(engine.tableId).paused &&
              result.value.version === 1 &&
              result.value.command_id === null &&
              fenced.get(engine).value === rows.get(engine.tableId).paused,
            'import_readback_mismatch'
          );
        }
      }
      unchanged(deadline);
      state.phase = 'import_verified';
      return {
        ok: true,
        phase: state.phase,
        handoffId: state.handoffId,
        fleet,
        retired,
        operatorRoutesRefused: true,
        futureStartFenced: true,
        bootQualified: false,
      };
    };
    state.phase = 'import_unknown';
    state.rpcStarted = true;
    state.importInFlight = true;
    let importResult;
    try {
      importResult = await modules.client.supabase.rpc('fn_ca_import_operator_holds', {
        p_handoff_id: options.handoffId,
        p_source_instance: options.expectedInstanceId,
        p_source_release_sha: options.expectedReleaseSha,
        p_fleet: fleet,
      });
    } finally {
      state.importInFlight = false;
    }
    const { data, error } = importResult;
    demand(
      !error &&
        data?.handoff_id === options.handoffId &&
        data.imported === fleet.length &&
        typeof data.replayed === 'boolean',
      'import_unknown'
    );
  }
  // Bounded parallel readback, one call per exact current engine, never a retry.
  for (let offset = 0; offset < current.length; offset += 32) {
    const results = await Promise.allSettled(
      current.slice(offset, offset + 32).map((engine) => readHold(engine, !firstUpgrade))
    );
    for (const [index, result] of results.entries()) {
      demand(result.status === 'fulfilled', 'hold_readback_unknown');
      if (firstUpgrade)
        demand(
          result.value.paused === rows.get(current[offset + index].tableId).paused &&
            result.value.version === 1 &&
            result.value.command_id === null,
          'import_readback_mismatch'
        );
    }
  }
  if (firstUpgrade) {
    for (const engine of current)
      demand(
        fenced.get(engine).value === rows.get(engine.tableId).paused,
        'import_readback_mismatch'
      );
  }
  unchanged();
  if (firstUpgrade) for (const engine of current) fenced.get(engine).restored = true;
  state.phase = firstUpgrade ? 'import_verified' : 'rollback_restored';
  state.liveRestorationPending = false;
  return {
    ok: true,
    phase: state.phase,
    handoffId: state.handoffId,
    fleet,
    retired,
    operatorRoutesRefused: true,
    futureStartFenced: true,
    bootQualified: false,
  };
}

/** Original preload calls this before importing original index.js. */
export async function installRollbackBootFence(options, modules) {
  return operatorHoldCheckpointGuard.call(
    null,
    { ...options, mode: 'rollback-boot' },
    [],
    modules,
    null
  );
}
