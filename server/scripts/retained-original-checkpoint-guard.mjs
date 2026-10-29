/**
 * One exact EED image, inside the existing one-shot certified release owner.
 * Private bytes never leave this process. No flag/method replacement, action,
 * disposition, permit release, or synthetic acknowledgement is performed here.
 */
export async function retainedOriginalCheckpointGuard(
  options,
  discoveredServers,
  modules,
  discoveredEngines,
  discoveredManagers
) {
  const pins = [
    ['/app/dist/GameServer.js', '813adcb6c6344f3307e80db966ba5eb4ffb4a651d9f3260f1df5db6544044845'],
    [
      '/app/dist/engine/ServerTableEngineBase.js',
      '36b670ff53d6e79c35dd515a5a7441431949c9caec7be8d22da557fa69753506',
    ],
    [
      '/app/dist/engine/ServerTableEngineSeating.js',
      'e08b3f0c763a3e3a85bb2c60a427939a34ad3dceea82475cd5cd1fedc9a9facd',
    ],
    [
      '/app/dist/engine/ServerTableEngineDealing.js',
      '0178fb9a817c85b5d203216dad376af64471de8bf498a3139c75048d82faf9f3',
    ],
    [
      '/app/dist/engine/ServerTableEngine.js',
      '7135e922db44b753f797fbe29baa81944b5d0135e76b4cc869bfb5dc3780fa4e',
    ],
    [
      '/app/dist/handlers/admin.js',
      '7600cf1b170b80e775691d413c8791aab3c441b09c3821c16951c06bdd67fc7e',
    ],
    [
      '/app/dist/tournament/TournamentManagerBase.js',
      'd05f1d47737283d31fc062b4c5c933364be1c3ed46b47f8a50d2ff8d1b158b7f',
    ],
    [
      '/app/dist/services/tableLease.js',
      'f6483c4692c99ad4042cdd174cb99a38346a507446306684a491c986ba1d4d0e',
    ],
    [
      '/app/dist/services/supabase/client.js',
      '88d2a25a95e0751dcc8227715e565be1326cef9914eb12ab8f8eb6a784a1dbbc',
    ],
    [
      '/app/dist/releaseIdentity.js',
      '3386b6a5740b7f6fa936b4e1f0727199b0d661e134dcb20424e602c1d3db8c89',
    ],
    [
      '/app/dist/http/createEngineHttpServer.js',
      '2925b3958172cb841a1c35c205b3566b6a25e155b8e01b1acec1f961fa6b2b9b',
    ],
    [
      '/app/dist/maintenance/MaintenanceBreak.js',
      'da14be32bd17de9cc5a8938d36299e35aad5f044c10dae12bdac40f1c19ccfb2',
    ],
    [
      '/app/dist/maintenance/freezeState.js',
      '58e29a6b619a14ddc298a7d995fee33cb771a72e949b3a1e212f3757226e44c5',
    ],
    [
      '/app/dist/services/supabase/dataActorContext.js',
      '106d071658a9bdccbb1302336650216e26851c2c4c0d4a4f2073f4e7c1384ace',
    ],
    [
      '/app/dist/engine/HandController.js',
      '2f0fcda3c64975845b11a827af959dc45fbcbc653f573777326558e8b23fd2b2',
    ],
    [
      '/app/dist/engine/HandContinuationLane.js',
      '00e55d58e06935f77e948577ad379f711783cc30b47a3fbf7b5aa12313a1c046',
    ],
    [
      '/app/dist/engine/PrivateHandContinuation.js',
      '9e4346da617ab105fed2338d9462d3453f057cc78b0f7957f2f476a79a3c997a',
    ],
    [
      '/app/dist/engine/TimeBankEngine.js',
      'a353075b987d80f8a5199f9bf4269a7db28a7bc0497d3502973f56c71a0ddd49',
    ],
    [
      '/app/dist/engine/DisconnectEngine.js',
      '9ed36e8c698a095b30fb9da5ec3f4415e5a11e952f87fea6b16ba64719f9933a',
    ],
    [
      '/app/dist/engine/ServerTableEngineTurns.js',
      'dbb8fe9ac711bea30d005bdb45924e6b6577371e11d532bfd74c6aabc09808c8',
    ],
    [
      '/app/dist/services/F06HandPermit.js',
      '148570f67cee93851275f6509a3f260fa7ba4079315e68cc6c716c832e1b1099',
    ],
    [
      '/app/dist/services/TournamentRetirementCustody.js',
      '15ef6475f8532e1af226460f54d1619f643fad81ae98c27adf833b725857d62c',
    ],
    [
      '/app/dist/services/supabase/handContinuation.js',
      'f0622654307aecb178d5b8ba2ed5fefaca6633870be8f36afbbbfaeea1cbe524',
    ],
    [
      '/app/dist/services/supabase/snapshots.js',
      '5de3e94861a3a6eac3f85e803cb47a8019b03bca38e093dd926bb97e0e2d47a2',
    ],
  ];
  const release = 'eed06fe51dea622069c661a6213d5b031ff3a9e3';
  const reserveMs = 245000;
  let stage = 'preflight',
    attemptedTables = 0,
    completedCalls = 0,
    verifiedTables = 0;
  let bankCount = 0,
    reason = null;
  const managerChildren = new Map();
  const need = (value, name) => {
    if (!value) throw new Error(name);
  };
  const uuid = (v) =>
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const digest = (v) => modules.crypto.createHash('sha256').update(v).digest('hex');
  const encode = (v) =>
    JSON.stringify(v, (_k, x) =>
      typeof x === 'bigint'
        ? { continuationBigInt: x.toString() }
        : x instanceof Map
          ? { continuationMap: [...x] }
          : x instanceof Set
            ? { continuationSet: [...x] }
            : x && typeof x === 'object' && !Array.isArray(x)
              ? Object.fromEntries(
                  Object.keys(x)
                    .sort()
                    .map((k) => [k, x[k]])
                )
              : x
    );
  const equal = (a, b) => encode(a) === encode(b);
  const sameMembers = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  const all = async (items, work) => {
    // Bound simultaneous native reads without truncating the census. Each item
    // executes once. Every initiated operation is joined, including refusals.
    let cursor = 0;
    const failures = [];
    await Promise.all(
      Array.from({ length: Math.min(32, items.length) }, async () => {
        for (;;) {
          const i = cursor++;
          if (i >= items.length) return;
          try {
            await work(items[i]);
          } catch (e) {
            failures.push(e);
          }
        }
      })
    );
    if (failures.length) throw failures[0];
  };
  try {
    need(
      options?.expectedReleaseSha === release && options.expectedPid === process.pid,
      'retained_process_identity_unproven'
    );
    need(
      modules.releaseIdentity?.ENGINE_RELEASE_IDENTITY?.releaseSha === release &&
        modules.tableLease?.INSTANCE_ID === options.expectedInstanceId,
      'retained_release_unproven'
    );
    need(
      Array.isArray(discoveredServers) &&
        discoveredServers.length === 1 &&
        discoveredServers[0] === this &&
        Object.getPrototypeOf(this) === modules.gameServer.GameServer.prototype,
      'retained_server_census_unproven'
    );
    for (const [path, hash] of pins) {
      const bytes = modules.fs.readFileSync(path);
      need(
        bytes.length > 0 && bytes.length <= 2097152 && digest(bytes) === hash,
        'retained_compiled_source_unproven'
      );
    }
    const base = modules.base.ServerTableEngineBase;
    const concrete = modules.engine.ServerTableEngine;
    const server = this,
      maintenance = server.maintenanceBreak;
    need(
      Object.getPrototypeOf(maintenance) === modules.maintenance.MaintenanceBreak.prototype,
      'retained_maintenance_owner_unproven'
    );
    need(
      Array.isArray(discoveredEngines) &&
        discoveredEngines.length <= 4000 &&
        new Set(discoveredEngines).size === discoveredEngines.length,
      'retained_object_census_unproven'
    );
    need(
      Array.isArray(discoveredManagers) &&
        discoveredManagers.length <= 2000 &&
        new Set(discoveredManagers).size === discoveredManagers.length,
      'retained_manager_census_unproven'
    );
    const managerObjects = new Set(discoveredManagers),
      managerWitnesses = new Map();
    const nativeManagerCapture =
      modules.managerBase.TournamentManagerBase.prototype.captureDrainedF06Originals;
    need(typeof nativeManagerCapture === 'function', 'retained_manager_capture_unavailable');
    const moveWitnesses = new Map();
    const proveManagerAuthorities = (m) => {
      for (const key of [
        'pendingTournamentSeatMoveOutcomes',
        'pendingTournamentParkRequests',
        'pendingTournamentBreakBegins',
        'pendingTournamentBreakAmendments',
        'rejectedTournamentBreakBegins',
        'resolvedTournamentBreakProposals',
        'pendingTournamentBreakCustodyIds',
        'pendingTournamentCleanupKinds',
        'pendingNoStartContinuations',
        'activeStoppedOriginalCustody',
        'stoppedOriginalBreaks',
        'tournamentBreakArrivalWakes',
      ])
        need(
          (m[key] instanceof Map || m[key] instanceof Set) && m[key].size === 0,
          'retained_manager_authority_unproven'
        );
      need(
        m.pendingTableBreakRetirement === null &&
          m.mixedRecoveryOperation === null &&
          m.capacityAdmissionOperation === null,
        'retained_manager_authority_unproven'
      );
      const witness = moveWitnesses.get(m);
      need(
        witness &&
          m.tournamentSeatMoveSerialTail === witness.tail &&
          m.tournamentSeatMoveAuthorityRevision === witness.revision,
        'retained_manager_serial_changed'
      );
    };
    const proveRetiredManager = (m) => {
      need(
        m instanceof modules.managerBase.TournamentManagerBase &&
          m.running === false &&
          m.stopFenceApplied === true &&
          m.teardownPromise === null &&
          m.lifecycleOperation === null &&
          record(m.lifecycleEpoch) &&
          m.lifecycleEpoch.token === null &&
          m.lifecycleEpoch.controller === null,
        'retained_detached_manager_work_unproven'
      );
      for (const key of [
        'lifecycleJobs',
        'tableEngineStartJobs',
        'tableEngineRunJobs',
        'eliminationSchedulerJobs',
        'lifecycleTimeouts',
        'lifecycleIntervals',
      ])
        need(m[key] instanceof Set && m[key].size === 0, 'retained_detached_manager_work_unproven');
      proveManagerAuthorities(m);
      const entries = m.drainedF06Originals;
      need(
        Array.isArray(entries) &&
          Object.isFrozen(entries) &&
          m.tableEngines instanceof Map &&
          entries.every(([id, e]) => discoveredEngines.includes(e) && e.tableId === id),
        'retained_detached_manager_custody_unproven'
      );
      if (m.tableEngines.size > 0)
        need(
          nativeManagerCapture.call(m) === entries,
          'retained_detached_manager_custody_unproven'
        );
      need(
        modules.managerBase.TournamentManagerBase.prototype.seatMoveQuarantineRefusal.call(m) ===
          null &&
          m.retainedTournamentBreakSources instanceof Map &&
          [...m.retainedTournamentBreakSources.values()].every(
            (value) =>
              discoveredEngines.includes(value.engine) &&
              value.engine.hasReleasedProcessOwnership() === true &&
              !value.engine.hasClaimedTournamentMoveBoundary()
          ),
        'retained_detached_manager_authority_unproven'
      );
      const captured = managerChildren.get(m);
      if (captured)
        need(
          entries.length === captured.entries.length &&
            entries.every(([id, e]) =>
              captured.entries.some(([oldId, old]) => id === oldId && e === old)
            ),
          'retained_manager_originals_changed'
        );
      const prior = managerWitnesses.get(m);
      if (prior)
        need(
          prior.map === m.tableEngines && entries === prior.entries,
          'retained_detached_manager_changed'
        );
      else managerWitnesses.set(m, { map: m.tableEngines, entries });
    };
    const initial = {
      phase: maintenance.phase,
      announcedAt: maintenance.announcedAt,
      breakStartedAt: maintenance.breakStartedAt,
      breakEndsAt: maintenance.breakEndsAt,
      reason: maintenance.reason,
      ownershipToken: maintenance.ownershipToken,
      lifecycleGeneration: maintenance.lifecycleGeneration,
      resumeToken: maintenance.resumeToken,
    };
    need(
      uuid(initial.ownershipToken) &&
        [
          'announcedAt',
          'breakStartedAt',
          'breakEndsAt',
          'lifecycleGeneration',
          'resumeToken',
        ].every((k) => Number.isSafeInteger(initial[k]) && initial[k] >= 0) &&
        initial.announcedAt > 0 &&
        initial.breakStartedAt >= initial.announcedAt &&
        initial.breakEndsAt > initial.breakStartedAt &&
        typeof initial.reason === 'string' &&
        initial.reason.length > 0 &&
        record(maintenance.lastDurableState),
      'retained_break_identity_unproven'
    );
    const startRemaining = maintenance.remainingMs(),
      startClock = performance.now();
    const generation = server.lifecycleGeneration;
    need(
      Number.isSafeInteger(generation) && generation >= 0,
      'retained_server_generation_unproven'
    );
    const liveMap = base.liveEngines;
    const direct = server.tableEngines,
      managers = server.tournamentEngines;
    need(
      liveMap instanceof Map &&
        direct instanceof Map &&
        managers instanceof Map &&
        liveMap.size <= 2000 &&
        direct.size <= 2000 &&
        managers.size <= 2000,
      'retained_registry_shape_unproven'
    );
    const directEntries = [...direct],
      managerEntries = [...managers],
      liveEntries = [...liveMap];
    const objects = new Set(discoveredEngines);
    const methods = new Map();
    const bindMethods = (target, names, tournamentId, leaseGeneration) => {
      const symbols = Object.getOwnPropertySymbols(target).filter(
        (s) => s.description === 'smarter.tournament-data-authority'
      );
      if (tournamentId) {
        need(symbols.length === 1, 'retained_actor_unproven');
        const d = Object.getOwnPropertyDescriptor(target, symbols[0]),
          a = d?.value;
        need(
          d?.configurable === false &&
            d.enumerable === false &&
            d.writable === false &&
            Object.isFrozen(a) &&
            a.actor === 'tournament-manager' &&
            a.tournamentId === tournamentId &&
            a.leaseGeneration === leaseGeneration,
          'retained_actor_unproven'
        );
        const wrapper = Function.prototype.toString.call(
          modules.dataActorContext.bindTournamentDataAuthority(a, () => {})
        );
        need(
          names.every(
            (n) =>
              typeof target[n] === 'function' &&
              Function.prototype.toString.call(target[n]) === wrapper
          ),
          'retained_method_owner_unproven'
        );
      } else
        need(
          names.every((n) => target[n] === base.prototype[n]),
          'retained_method_owner_unproven'
        );
      methods.set(
        target,
        names.map((n) => [n, target[n]])
      );
    };
    const checkMaintenance = () => {
      need(
        modules.dataActorContext.currentTournamentDataAuthority() === null,
        'retained_process_actor_unproven'
      );
      need(
        server.running === true &&
          server.teardownPromise === null &&
          server.lifecycleGeneration === generation &&
          server.tableEngines === direct &&
          server.tournamentEngines === managers &&
          server.maintenanceBreak === maintenance,
        'retained_server_changed'
      );
      need(
        modules.freezeState.isMaintenanceFrozen() === true &&
          maintenance.phase === 'counting_down' &&
          maintenance.durableConfirmed === true &&
          maintenance.ending === false &&
          maintenance.stopOperation === null &&
          maintenance.releaseBoundaryOnly === false &&
          maintenance.recoveryReadPending === false,
        'retained_durable_freeze_unproven'
      );
      need(
        Object.entries(initial).every(([k, v]) => maintenance[k] === v) &&
          [
            'phase',
            'announcedAt',
            'breakStartedAt',
            'breakEndsAt',
            'reason',
            'ownershipToken',
          ].every((k) => maintenance.lastDurableState?.[k] === initial[k]),
        'retained_break_changed'
      );
      need(
        Math.min(maintenance.remainingMs(), startRemaining - (performance.now() - startClock)) >=
          reserveMs,
        'retained_reserve_exhausted'
      );
      need(
        [...direct].every(([id, e]) =>
          directEntries.some(([oldId, old]) => id === oldId && e === old)
        ) &&
          (stage !== 'preflight' || direct.size === directEntries.length) &&
          sameMembers(
            [...managers].map(([k, v]) => v),
            managerEntries.map(([k, v]) => v)
          ),
        'retained_registry_changed'
      );
      need(
        [...base.liveEngines.values()].every((e) => objects.has(e)),
        'retained_new_engine_unproven'
      );
      for (const [m, c] of managerChildren) {
        need(
          m.tableEngines === c.map &&
            m.tournamentLeaseGeneration === c.generation &&
            [...c.map].every(([id, e]) =>
              c.entries.some(([oldId, old]) => id === oldId && e === old)
            ) &&
            (stage !== 'preflight' || c.map.size === c.entries.length),
          'retained_manager_children_changed'
        );
      }
      for (const [m] of managerWitnesses) proveRetiredManager(m);
      for (const [target, rows] of methods)
        need(
          rows.every(([n, f]) => target[n] === f),
          'retained_method_changed'
        );
    };
    checkMaintenance();
    for (const m of discoveredManagers) {
      need(
        m instanceof modules.managerBase.TournamentManagerBase &&
          uuid(m.tournamentId) &&
          uuid(m.tournamentLeaseGeneration) &&
          m.tournamentSeatMoveSerialTail instanceof Promise &&
          Number.isSafeInteger(m.tournamentSeatMoveAuthorityRevision),
        'retained_manager_census_unproven'
      );
      bindMethods(
        m,
        ['stop', 'captureDrainedF06Originals', 'seatMoveQuarantineRefusal'],
        m.tournamentId,
        m.tournamentLeaseGeneration
      );
      moveWitnesses.set(m, {
        tail: m.tournamentSeatMoveSerialTail,
        revision: m.tournamentSeatMoveAuthorityRevision,
      });
    }
    await all(discoveredManagers, async (m) => {
      await moveWitnesses.get(m).tail;
      checkMaintenance();
      proveManagerAuthorities(m);
      if (!managerEntries.some(([, current]) => current === m)) proveRetiredManager(m);
    });
    const owned = new Map();
    for (const [id, e] of directEntries) {
      need(uuid(id) && e.tableId === id && objects.has(e), 'retained_direct_owner_missing');
      owned.set(e, null);
    }
    for (const [id, m] of managerEntries) {
      need(
        managerObjects.has(m) &&
          uuid(id) &&
          m.tournamentId === id &&
          m.tableEngines instanceof Map &&
          m.tableEngines.size <= 2000,
        'retained_manager_shape_unproven'
      );
      need(
        m.running === true && m.teardownPromise === null && m.stopRequested !== true,
        'retained_manager_not_current'
      );
      need(
        m instanceof modules.managerBase.TournamentManagerBase &&
          uuid(m.tournamentLeaseGeneration) &&
          m.tournamentLeaseAuthorityExpired === false &&
          Number.isFinite(m.tournamentLeaseProofDeadlineMonotonicMs) &&
          performance.now() < m.tournamentLeaseProofDeadlineMonotonicMs,
        'retained_manager_lease_unproven'
      );
      bindMethods(m, ['stop'], id, m.tournamentLeaseGeneration);
      managerChildren.set(m, {
        map: m.tableEngines,
        entries: [...m.tableEngines],
        generation: m.tournamentLeaseGeneration,
      });
      for (const [tableId, e] of m.tableEngines) {
        need(
          objects.has(e) && e.tableId === tableId && (!owned.has(e) || owned.get(e) === null),
          'retained_manager_engine_unproven'
        );
        owned.set(e, m);
      }
      // No detached retirement/candidate source may be silently dropped. The
      // all-object pass below refuses any such source that still holds work.
    }
    for (const [id, e] of liveEntries)
      need(
        id === e.tableId && objects.has(e) && owned.has(e),
        'retained_live_engine_owner_missing'
      );
    const captures = [],
      shadows = [];
    const noWork = (e) => {
      for (const n of [
        'settlementInFlight',
        'tournamentMoveOperations',
        'readContinuationTasks',
        'timeBankAccountingPending',
        'unresolvedTimeBankDebits',
        'entryHoldWriteChains',
      ])
        need(
          (e[n] instanceof Set || e[n] instanceof Map) && e[n].size === 0,
          'retained_physical_work_unproven'
        );
      need(
        (e.weeklyPayoutOriginalWorkSet === undefined || e.weeklyPayoutOriginalWorkSet.size === 0) &&
          e.postHandTasksPromise === null &&
          e.snapshotFlushPromise === null &&
          e.snapshotDirty === false &&
          e.presenceSavePending === 0 &&
          e.timeBankAccountingUnconfirmed === false &&
          e.actionLock === false &&
          e.preparedOriginalRetentionUnconfirmed === false,
        'retained_unconfirmed_work'
      );
    };
    for (const e of discoveredEngines) {
      need(Object.getPrototypeOf(e) === concrete.prototype, 'retained_engine_prototype_unproven');
      if (!owned.has(e)) {
        const oldAuthority = base.prototype.getEngineLeaseAuthority.call(e);
        const oldSymbols = Object.getOwnPropertySymbols(e).filter(
          (s) => s.description === 'smarter.tournament-data-authority'
        );
        need(oldSymbols.length <= 1, 'retained_actor_unproven');
        const oldActor = oldSymbols.length
          ? Object.getOwnPropertyDescriptor(e, oldSymbols[0])?.value
          : null;
        if (oldActor)
          need(
            uuid(oldActor.tournamentId) &&
              uuid(oldActor.leaseGeneration) &&
              oldAuthority?.scope === 'tournament' &&
              oldAuthority.tournamentId === oldActor.tournamentId,
            'retained_actor_unproven'
          );
        else
          need(oldAuthority === null || oldAuthority.scope === 'cash', 'retained_actor_unproven');
        bindMethods(
          e,
          [
            'getEngineLeaseAuthority',
            'hasReleasedProcessOwnership',
            'hasUnretiredStoppedTimeBankCustody',
            'hasClaimedTournamentMoveBoundary',
          ],
          oldActor?.tournamentId ?? null,
          oldActor?.leaseGeneration
        );
        need(
          e.terminal === true &&
            e.running === false &&
            e.terminalTeardownComplete === true &&
            e.handController === null &&
            e.hasReleasedProcessOwnership() === true &&
            e.hasUnretiredStoppedTimeBankCustody() === false,
          'retained_detached_owner_unproven'
        );
        noWork(e);
        shadows.push({
          e,
          original: e.pendingOriginalContinuation,
          packet: e.pendingOriginalContinuation
            ? modules.privateContinuation.encodePrivateHandContinuation(
                e.pendingOriginalContinuation
              )
            : null,
          lane: e.handContinuation,
          tail: e.handContinuation?.tail,
          handNumber: e.handCount,
        });
        continue;
      }
      noWork(e);
      const a = e.getEngineLeaseAuthority();
      need(
        a?.verified === true &&
          Number.isFinite(a.proofDeadlineMonotonicMs) &&
          performance.now() < a.proofDeadlineMonotonicMs &&
          e.isCurrentEngine() === true &&
          e.running === true &&
          e.terminal === false &&
          e.engineLeaseAuthorityExpired === false &&
          e.maintenancePaused === true,
        'retained_engine_authority_unproven'
      );
      bindMethods(
        e,
        [
          'stop',
          'persistStoppedTimeBankCustody',
          'getEngineLeaseAuthority',
          'captureContinuationEngine',
          'captureParkedTimeBanks',
          'hasUnretiredStoppedTimeBankCustody',
          'hasReleasedProcessOwnership',
        ],
        a.scope === 'tournament' ? a.tournamentId : null,
        a.generation
      );
      const original = e.pendingOriginalContinuation;
      if (e.handController !== null || original !== null || e.handContinuation !== null) {
        need(
          a.scope === 'tournament' &&
            record(original) &&
            e.handContinuation === null &&
            e.handController &&
            Object.getPrototypeOf(e.handController) === modules.controller.HandController.prototype,
          'retained_original_stage_unproven'
        );
        need(
          e.handController.serializeRecoveryState() === original.batch.controller &&
            Number(original.original.hand_number) === e.handCount &&
            original.original.table_id === e.tableId &&
            original.original.tournament_id === a.tournamentId,
          'retained_controller_changed'
        );
        const captured = e.captureContinuationEngine(),
          saved = original.batch.engine;
        need(
          equal(captured.fields, saved.fields) &&
            equal(captured.timeBankMeta, saved.timeBankMeta) &&
            equal(captured.timeBankDebits, saved.timeBankDebits) &&
            equal(captured.timeBanks, saved.timeBanks),
          'retained_engine_capture_changed'
        );
        // Presence is the only time-dependent capture. Exact stopped canonical
        // park/readback below owns it; successor startup registers that park
        // before restoreFsmStates, whose compiled owner never clobbers a player.
      } else need(e.isBetweenHands() === true, 'retained_idle_boundary_unproven');
      const banks = e.captureParkedTimeBanks();
      for (const bank of e.timeBankEngine.getBanksForTable(e.tableId))
        need(
          bank.isActive === false && (original || bank.armed === false) && banks[bank.playerId],
          'retained_bank_unknown'
        );
      const packet = original
        ? modules.privateContinuation.encodePrivateHandContinuation(original)
        : null;
      captures.push({
        e,
        a,
        original,
        packet,
        controller: e.handController,
        banks,
        presence: e.captureRetainedPresence(),
        chairs: encode(e.seatedPlayers),
        capture: e.captureContinuationEngine(),
      });
      bankCount += Object.keys(banks).length;
    }
    need(captures.length > 0 && captures.length <= 2000, 'retained_empty_or_excessive_fleet');
    const readPark = async (c) => {
      const q = await modules.client.supabase
        .from('engine_presence_parked')
        .select('table_id,parked_at,engine_instance,disconnect_states,time_bank_snapshot')
        .eq('table_id', c.e.tableId)
        .maybeSingle();
      checkMaintenance();
      need(!q?.error, 'retained_native_park_unreadable');
      return q.data;
    };
    const presenceMatches = (stored, current) => {
      if (
        !record(stored) ||
        !record(current) ||
        !equal(Object.keys(stored).sort(), Object.keys(current).sort())
      )
        return false;
      return Object.keys(current).every((id) => {
        const a = stored[id],
          b = current[id];
        if (equal(a, b)) return true;
        // A connected heartbeat has no paid allocation or grace deadline. This
        // is the only value allowed to move beyond its positive native park.
        if (
          a?.state !== 'CONNECTED' ||
          b?.state !== 'CONNECTED' ||
          !Number.isFinite(a.sinceMs) ||
          !Number.isFinite(b.sinceMs) ||
          b.sinceMs < a.sinceMs
        )
          return false;
        const { sinceMs: _a, ...restA } = a,
          { sinceMs: _b, ...restB } = b;
        return equal(restA, restB);
      });
    };
    const verifyPark = (c, row, banks, presence, stopped) => {
      const needsRow = Object.keys(banks).length > 0 || Object.keys(presence).length > 0;
      if (!needsRow) return;
      const snapshot = row?.time_bank_snapshot;
      need(
        row?.table_id === c.e.tableId &&
          snapshot?.version === 1 &&
          snapshot.handNumber === c.e.handCount &&
          Date.parse(snapshot.parkedAt) === Date.parse(row.parked_at) &&
          equal(snapshot.players, banks) &&
          presenceMatches(row.disconnect_states, presence) &&
          row.engine_instance ===
            `${options.expectedInstanceId}:${stopped ? 'stopped_custody' : 'parked'}` &&
          Date.parse(row.parked_at) >= initial.announcedAt &&
          Date.parse(row.parked_at) <= Date.now(),
        'retained_native_park_unproven'
      );
      for (const seat of c.e.seatedPlayers)
        if (banks[seat.user_id])
          need(
            banks[seat.user_id].occupancyId === seat.occupancy_id,
            'retained_park_occupancy_changed'
          );
    };
    const trulyEmpty = (c) =>
      !c.original &&
      c.controller === null &&
      c.e.seatedPlayers.length === 0 &&
      Object.keys(c.banks).length === 0 &&
      Object.keys(c.presence).length === 0 &&
      c.e.timeBankMeta.size === 0 &&
      Object.keys(c.e.parkedTimeBanks).length === 0;
    const attest = async (c) => {
      if (!c.original) return;
      const binding = c.original.original;
      const response = await modules.dataActorContext.bindTournamentDataAuthority(
        { tournamentId: c.a.tournamentId, leaseGeneration: c.a.generation },
        () =>
          modules.client.supabase.rpc('fn_f06_attest_frozen_hand_continuation', {
            p_tournament_id: c.a.tournamentId,
            p_lease_generation: c.a.generation,
            p_table_id: c.e.tableId,
            p_hand_number: binding.hand_number,
            p_sequence: c.original.batch.sequence,
            p_payload_sha256: c.packet.sha256,
          })
      )();
      checkMaintenance();
      const r = response?.data;
      need(
        !response?.error &&
          r?.ok === true &&
          r.frozen === true &&
          r.table_id === c.e.tableId &&
          String(r.hand_number) === String(binding.hand_number) &&
          String(r.sequence) === String(c.original.batch.sequence) &&
          r.sha256 === c.packet.sha256 &&
          r.controller_sha256 === digest(c.original.batch.controller) &&
          r.writer_generation === c.a.generation &&
          r.tournament_id === binding.tournament_id &&
          r.permit_id === binding.permit_id &&
          r.original_generation === binding.lease_generation &&
          String(r.lifecycle) === String(binding.lifecycle) &&
          r.custody_id === binding.custody_id &&
          Date.parse(r.announced_at) === initial.announcedAt &&
          Date.parse(r.break_started_at) === initial.breakStartedAt &&
          Date.parse(r.break_ends_at) === initial.breakEndsAt,
        'retained_native_original_unproven'
      );
    };
    await all(captures, async (c) => {
      await attest(c);
      // Cash stop disposes banks instead of creating stopped custody. Only its
      // already-completed canonical maintenance park can authorize that stop.
      // The same proof is mandatory for zero-bank nonempty presence, whose
      // stopped-custody owner has no bank write to perform.
      if (trulyEmpty(c)) return;
      if (c.a.scope === 'cash' || Object.keys(c.banks).length === 0) {
        need(
          c.e.parkedBankSaveComplete === true &&
            c.e.isMaintenanceStateDurable() === true &&
            c.e.acknowledgedTimeBankPark?.handNumber === c.e.handCount &&
            c.e.acknowledgedTimeBankPark.banks ===
              JSON.stringify(Object.entries(c.banks).sort(([a], [b]) => a.localeCompare(b))),
          'retained_cash_park_ack_unproven'
        );
        c.prePark = await readPark(c);
        verifyPark(c, c.prePark, c.banks, c.presence, false);
      }
    });
    await all(shadows, async (s) => {
      if (s.tail) await s.tail;
      checkMaintenance();
      noWork(s.e);
      need(
        s.e.pendingOriginalContinuation === s.original &&
          s.e.handContinuation === s.lane &&
          s.e.handCount === s.handNumber &&
          (!s.lane ||
            (s.lane.tail === s.tail &&
              s.lane.scheduled === false &&
              s.lane.pending.length === 0 &&
              s.lane.controlDirty === false &&
              s.lane.failed === false &&
              s.lane.unretainedBatches === 0 &&
              Number.isSafeInteger(s.lane.sequence) &&
              s.lane.retainedSequence === s.lane.sequence &&
              Array.isArray(s.lane.retentionWaiters) &&
              s.lane.retentionWaiters.length === 0)),
        'retained_shadow_work_changed'
      );
      if (
        s.handNumber === 0 &&
        s.original === null &&
        s.lane === null &&
        s.e.timeBankMeta.size === 0 &&
        Object.keys(s.e.parkedTimeBanks).length === 0
      )
        return;
      const successor =
        s.original &&
        captures.find(
          (c) =>
            c.original &&
            equal(c.original.original, s.original.original) &&
            c.original.batch.sequence >= Math.max(s.original.batch.sequence, s.lane?.sequence ?? 0)
        );
      if (successor) return; // Its current native capsule was positively attested above.
      const commit = await modules.client.supabase
        .from('hand_atomic_commits')
        .select('table_id,hand_number,hand_id,post_commit_completed_at,post_commit_result')
        .eq('table_id', s.e.tableId)
        .eq('hand_number', s.handNumber)
        .maybeSingle();
      checkMaintenance();
      need(
        !commit?.error &&
          commit?.data?.hand_id &&
          commit.data.post_commit_completed_at &&
          commit.data.post_commit_result?.ok === true,
        'retained_shadow_disposition_unproven'
      );
      const history = await modules.client.supabase
        .from('hand_history')
        .select('id,table_id,hand_number')
        .eq('table_id', s.e.tableId)
        .eq('hand_number', s.handNumber)
        .eq('id', commit.data.hand_id)
        .maybeSingle();
      checkMaintenance();
      need(
        !history?.error && history?.data?.id === commit.data.hand_id,
        'retained_shadow_history_unproven'
      );
    });
    // Recheck every original and every physical owner synchronously BEFORE the
    // first fence. No async gap may allow an accepted mutation to disappear.
    checkMaintenance();
    for (const c of captures) {
      noWork(c.e);
      const freshAuthority = c.e.getEngineLeaseAuthority(),
        freshCapture = c.e.captureContinuationEngine();
      const manager = owned.get(c.e);
      if (manager)
        need(
          manager.tournamentLeaseAuthorityExpired === false &&
            performance.now() < manager.tournamentLeaseProofDeadlineMonotonicMs,
          'retained_manager_lease_expired'
        );
      need(
        freshAuthority?.verified === true &&
          freshAuthority.generation === c.a.generation &&
          freshAuthority.tournamentId === c.a.tournamentId &&
          performance.now() < freshAuthority.proofDeadlineMonotonicMs &&
          c.e.isCurrentEngine() === true &&
          c.e.running === true &&
          c.e.terminal === false &&
          c.e.engineLeaseAuthorityExpired === false,
        'retained_pre_stop_authority_changed'
      );
      if (c.original)
        need(
          equal(freshCapture.fields, c.original.batch.engine.fields) &&
            equal(freshCapture.timeBankMeta, c.original.batch.engine.timeBankMeta) &&
            equal(freshCapture.timeBankDebits, c.original.batch.engine.timeBankDebits) &&
            equal(freshCapture.timeBanks, c.original.batch.engine.timeBanks),
          'retained_pre_stop_capture_changed'
        );
      need(
        c.e.handController === c.controller &&
          c.e.pendingOriginalContinuation === c.original &&
          encode(c.e.seatedPlayers) === c.chairs &&
          equal(c.e.captureParkedTimeBanks(), c.banks) &&
          (!c.packet ||
            modules.privateContinuation.encodePrivateHandContinuation(c.original).sha256 ===
              c.packet.sha256) &&
          (!c.controller || c.controller.serializeRecoveryState() === c.original.batch.controller),
        'retained_pre_stop_changed'
      );
    }
    for (const s of shadows) {
      noWork(s.e);
      need(
        s.e.terminalTeardownComplete === true &&
          s.e.hasReleasedProcessOwnership() === true &&
          !s.e.hasUnretiredStoppedTimeBankCustody() &&
          s.e.handController === null &&
          s.e.pendingOriginalContinuation === s.original &&
          s.e.handContinuation === s.lane &&
          (!s.packet ||
            modules.privateContinuation.encodePrivateHandContinuation(s.original).sha256 ===
              s.packet.sha256) &&
          (!s.lane ||
            (s.lane.tail === s.tail &&
              s.lane.failed === false &&
              s.lane.unretainedBatches === 0 &&
              s.lane.retainedSequence === s.lane.sequence &&
              s.lane.pending.length === 0 &&
              s.lane.scheduled === false &&
              s.lane.controlDirty === false &&
              s.lane.retentionWaiters.length === 0)),
        'retained_shadow_changed'
      );
    }
    for (const m of discoveredManagers) proveManagerAuthorities(m);
    stage = 'checkpoint';
    attemptedTables = captures.length;
    // Calling the real manager stop fences its scheduler and every exact child
    // synchronously; calling a child alone would permit a fresh admission race.
    const stops = managerEntries.map(([, m]) => m.stop());
    for (const c of captures) if (!owned.get(c.e)) stops.push(c.e.stop());
    const results = await Promise.allSettled(stops);
    completedCalls = results.length;
    need(
      results.every((r) => r.status === 'fulfilled'),
      'retained_stop_failed'
    );
    stage = 'readback';
    checkMaintenance();
    for (const [, m] of managerEntries) {
      const tail = m.tournamentSeatMoveSerialTail,
        revision = m.tournamentSeatMoveAuthorityRevision;
      await tail;
      checkMaintenance();
      moveWitnesses.set(m, { tail, revision });
      proveRetiredManager(m);
    }
    await all(captures, async (c) => {
      need(
        c.e.terminalTeardownComplete === true && c.e.hasReleasedProcessOwnership() === true,
        'retained_stop_custody_unproven'
      );
      if (!owned.get(c.e)) await c.e.persistStoppedTimeBankCustody();
      need(c.e.hasUnretiredStoppedTimeBankCustody() === false, 'retained_stop_custody_unproven');
      if (c.packet) {
        need(
          modules.privateContinuation.encodePrivateHandContinuation(c.original).sha256 ===
            c.packet.sha256 &&
            c.controller.serializeRecoveryState() === c.original.batch.controller,
          'retained_stopped_original_changed'
        );
        await attest(c);
      }
      if (trulyEmpty(c)) {
        verifiedTables++;
        return;
      }
      const row = await readPark(c),
        custody = c.e.stoppedTimeBankCustody;
      if (custody && Object.keys(custody.banks).length) {
        need(
          custody.handNumber === Number(c.original?.original.hand_number ?? c.e.handCount) &&
            equal(custody.banks, c.banks),
          'retained_stopped_bank_changed'
        );
        verifyPark(c, row, custody.banks, custody.disconnectStates, true);
      } else {
        verifyPark(c, row, c.banks, c.presence, false);
        need(equal(row, c.prePark), 'retained_existing_park_changed');
      }
      verifiedTables++;
    });
    checkMaintenance();
    need(
      base.liveEngines.size === 0 &&
        captures.every(
          (c) => c.e.terminalTeardownComplete === true && !c.e.hasUnretiredStoppedTimeBankCustody()
        ),
      'retained_final_census_unproven'
    );
    stage = 'complete';
  } catch (e) {
    reason =
      typeof e?.message === 'string' && /^[a-z_]+$/.test(e.message)
        ? e.message
        : 'retained_checkpoint_unconfirmed';
  }
  const ok = reason === null;
  return {
    schema: 'legacy-engine-checkpoint/v1',
    ok,
    reason,
    stage,
    attemptedTables,
    completedCalls,
    verifiedTables,
    bankCount,
    uninitializedSeats: 0,
    remainingMs: this.maintenanceBreak?.remainingMs?.() ?? 0,
    readyForRestart: ok,
    checkpointOutcome: ok
      ? 'verified_at_observation'
      : attemptedTables
        ? 'unconfirmed'
        : 'not_started',
    paidAccountingQualification: ok
      ? 'native_pending_registry_drained'
      : 'native_pending_registry_unqualified',
    restartAuthorized: false,
  };
}
