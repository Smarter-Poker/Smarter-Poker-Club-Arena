import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  operatorHoldCheckpointGuard,
  installRollbackBootFence,
} from '../../server/scripts/operator-hold-checkpoint-guard.mjs';

const table = '10000000-0000-0000-0000-000000000001';
const generation = '20000000-0000-0000-0000-000000000001';
const handoff = '30000000-0000-0000-0000-000000000001';
const release = '5adefba4ac868bf138bee41bda24ae4b1754e456';

function fixture(mode = 'first-upgrade') {
  class Base {
    tableId: string;
    adminPauseLock = false;
    engineLeaseVerified = true;
    engineLeaseGeneration = generation;
    terminal = false;
    teardownPromise = null;
    handController = null;
    maintenancePaused = true;
    readyValue: boolean | null = null;
    observedStartHold: boolean | null = null;
    currentLease = true;
    constructor(id = table) {
      this.tableId = id;
    }
    engineLeaseAuthorityIsCurrent() {
      return this.currentLease;
    }
    hasReleasedProcessOwnership() {
      return false;
    }
    settleReady(value: boolean) {
      this.readyValue = value;
    }
    async start() {
      this.observedStartHold = this.adminPauseLock;
    }
    isNextHandPaused() {
      return this.adminPauseLock || this.maintenancePaused;
    }
    resumeFromMaintenance() {
      this.maintenancePaused = false;
    }
    resumeDealing() {
      this.maintenancePaused = false;
    }
  }
  class Dealing extends Base {
    async dealHand() {
      return 'actual-deal-boundary';
    }
  }
  class Seating extends Dealing {
    adminPause() {
      this.adminPauseLock = true;
      return { success: true };
    }
    adminResume() {
      this.adminPauseLock = false;
      return { success: true };
    }
  }
  class Manager {}
  class GameServer {
    tableEngines = new Map<string, Base>();
    tournamentEngines = new Map();
    tournamentDiagnosticRetirements = new Map();
    drainedF06TournamentCustody = new Map();
    completedF06TournamentCustody = new Map();
    maintenanceBreak = { readyForRestart: () => true, snapshot: () => ({ remainingMs: 300000 }) };
  }
  class HttpServer extends EventEmitter {
    listening = false;
    port = 8080;
    listen(port: number, callback?: () => void) {
      this.port = port;
      this.listening = true;
      callback?.();
      return this;
    }
    address() {
      return { port: this.port };
    }
  }
  const gs = new GameServer();
  const engine = new Seating();
  engine.adminPauseLock = true;
  gs.tableEngines.set(table, engine);
  const http = new HttpServer();
  const forwarded: unknown[][] = [];
  const originalListener = function (...args: unknown[]) {
    forwarded.push(args);
  };
  http.on('request', originalListener);
  http.listen(8080);
  const holds = new Map([[table, { paused: true, version: 1, command_id: null }]]);
  const calls: Array<{ name: string; args: any }> = [];
  let intercept: ((name: string, args: any) => any) | null = null;
  const modules = {
    base: { ServerTableEngineBase: Base },
    seating: { ServerTableEngineSeating: Seating },
    dealing: { ServerTableEngineDealing: Dealing },
    gameServer: { GameServer },
    managerBase: { TournamentManagerBase: Manager },
    http: { Server: HttpServer },
    tableLease: { INSTANCE_ID: 'test-instance' },
    releaseIdentity: { ENGINE_RELEASE_IDENTITY: { releaseSha: release } },
    client: {
      supabase: {
        rpc: async (name: string, args: any) => {
          calls.push({ name, args });
          const override = await intercept?.(name, args);
          if (override !== undefined) return override;
          if (name === 'fn_ca_import_operator_holds') {
            for (const row of args.p_fleet)
              holds.set(row.table_id, { paused: row.paused, version: 1, command_id: null });
            return {
              data: {
                handoff_id: args.p_handoff_id,
                imported: args.p_fleet.length,
                replayed: false,
              },
              error: null,
            };
          }
          return {
            data: holds.get(args.p_table_id) ?? { paused: false, version: 0, command_id: null },
            error: null,
          };
        },
      },
    },
  };
  const options = {
    mode,
    handoffId: handoff,
    expectedPid: process.pid,
    expectedReleaseSha: release,
    expectedInstanceId: 'test-instance',
    proofDeadline: Date.now() + 10_000,
  };
  const run = () => operatorHoldCheckpointGuard.call(gs, options, [gs], modules, http);
  const request = (method: string, url: string) => {
    const result = {
      status: 0,
      body: '',
      writeHead(status: number) {
        this.status = status;
      },
      end(body: string) {
        this.body = body;
      },
    };
    const req = { method, url, untouchedRole: 'existing-auth-identity' };
    http.emit('request', req, result);
    return { req, result };
  };
  return {
    gs,
    engine,
    http,
    modules,
    options,
    run,
    calls,
    holds,
    forwarded,
    originalListener,
    request,
    Base,
    Seating,
    HttpServer,
    Manager,
    intercept: (fn: (name: string, args: any) => any) => {
      intercept = fn;
    },
  };
}

describe('original operator hold checkpoint guard', () => {
  it('refuses the historical a29 profile before fencing or native import', async () => {
    const f = fixture();
    f.options.expectedReleaseSha = 'a29a591da2efa8acb1a67cbb93f5e67af11cfc1f';
    await expect(f.run()).rejects.toThrow('identity');
    expect(f.calls).toHaveLength(0);
    expect(f.http.listeners('request')).toEqual([f.originalListener]);
  });
  it('refuses insufficient untouched rollback reserve before fencing or native import', async () => {
    const f = fixture();
    f.gs.maintenanceBreak.snapshot = () => ({ remainingMs: 244999 });
    await expect(f.run()).rejects.toThrow('rollback_reserve');
    expect(f.calls).toHaveLength(0);
    expect(f.http.listeners('request')).toEqual([f.originalListener]);
    expect(f.engine.adminResume().success).toBe(true);
  });
  it('demonstrates lost constructor authority before the guard and restores it before rollback start', async () => {
    const f = fixture('rollback');
    const before = new f.Seating();
    await before.start();
    expect(before.observedStartHold).toBe(false);
    await f.run();
    const after = new f.Seating();
    await after.start();
    expect(after.observedStartHold).toBe(true);
    expect(after.maintenancePaused).toBe(true);
  });

  it('imports the complete idle true/false fleet once without lifecycle status writes', async () => {
    const f = fixture();
    const second = new f.Seating('10000000-0000-0000-0000-000000000002');
    f.gs.tableEngines.set(second.tableId, second);
    const result = await f.run();
    expect(result.phase).toBe('import_verified');
    expect(result.fleet.map((row: any) => row.paused)).toEqual([true, false]);
    expect(f.calls.map((call) => call.name)).toEqual([
      'fn_ca_import_operator_holds',
      'fn_ca_get_table_operator_hold',
      'fn_ca_get_table_operator_hold',
    ]);
    await expect(f.run()).rejects.toThrow('already_installed');
    expect(f.calls.filter((call) => call.name === 'fn_ca_import_operator_holds')).toHaveLength(1);
  });

  it('replaces the original listener and refuses only exact operator POST paths', async () => {
    const f = fixture();
    await f.run();
    expect(f.http.rawListeners('request')).toHaveLength(1);
    expect(f.http.rawListeners('request')[0]).not.toBe(f.originalListener);
    for (const path of ['/admin/pause', '/admin/resume?source=existing']) {
      expect(f.request('POST', path).result.status).toBe(503);
    }
    const allowed = f.request('POST', '/admin/maintenance');
    f.request('GET', '/admin/pause');
    f.request('POST', '/admin/pause-extra');
    expect(f.forwarded).toHaveLength(3);
    expect(f.forwarded[0][0]).toBe(allowed.req);
  });

  it('fences captured in-flight setters and already bound own methods', async () => {
    const f = fixture();
    const captured = f.engine.adminResume.bind(f.engine);
    Object.defineProperty(f.engine, 'adminPause', {
      value: f.engine.adminPause.bind(f.engine),
      configurable: true,
    });
    await f.run();
    expect(() => captured()).toThrow('operator_commands_unavailable');
    expect(() => f.engine.adminPause()).toThrow('operator_commands_unavailable');
    expect(f.engine.adminPauseLock).toBe(true);
  });

  it('keeps an unknown import fenced and never retries it', async () => {
    const f = fixture();
    f.intercept((name) =>
      name === 'fn_ca_import_operator_holds'
        ? { error: { code: 'transport_unknown' }, data: null }
        : undefined
    );
    await expect(f.run()).rejects.toThrow('import_unknown');
    expect(f.request('POST', '/admin/resume').result.status).toBe(503);
    expect(f.engine.adminPauseLock).toBe(true);
    expect(f.calls).toHaveLength(1);
    f.engine.resumeFromMaintenance();
    expect(f.engine.maintenancePaused).toBe(false);
    expect(f.engine.isNextHandPaused()).toBe(true);
    await expect(f.run()).rejects.toThrow('already_installed');
  });

  it('recovers the same committed handoff after a lost import acknowledgment without importing again', async () => {
    const f = fixture();
    f.intercept((name) =>
      name === 'fn_ca_import_operator_holds'
        ? { error: { code: 'lost_ack' }, data: null }
        : undefined
    );
    await expect(f.run()).rejects.toThrow('import_unknown');
    const listener = f.http.rawListeners('request')[0];
    f.intercept((name) =>
      name === 'fn_ca_get_operator_hold_handoff'
        ? {
            error: null,
            data: {
              handoff_id: handoff,
              source_instance: f.options.expectedInstanceId,
              source_release_sha: release,
              fleet: [{ table_id: table, paused: true, lease_generation: generation }],
            },
          }
        : undefined
    );
    f.options.mode = 'resume-first-upgrade';
    const result = await f.run();
    expect(result.phase).toBe('import_verified');
    expect(f.calls.map((call) => call.name)).toEqual([
      'fn_ca_import_operator_holds',
      'fn_ca_get_operator_hold_handoff',
      'fn_ca_get_table_operator_hold',
    ]);
    expect(f.http.rawListeners('request')[0]).toBe(listener);
    expect(f.request('POST', '/admin/resume').result.status).toBe(503);
    expect(f.engine.adminPauseLock).toBe(true);
  });

  it.each(['absent', 'error', 'uuid', 'instance', 'release', 'fleet'])(
    'refuses %s immutable receipt without another import',
    async (kind) => {
      const f = fixture();
      f.intercept((name) =>
        name === 'fn_ca_import_operator_holds'
          ? { error: { code: 'lost_ack' }, data: null }
          : undefined
      );
      await expect(f.run()).rejects.toThrow('import_unknown');
      const receipt: any = {
        handoff_id: handoff,
        source_instance: f.options.expectedInstanceId,
        source_release_sha: release,
        fleet: [{ table_id: table, paused: true, lease_generation: generation }],
      };
      if (kind === 'uuid') receipt.handoff_id = generation;
      if (kind === 'instance') receipt.source_instance = 'other-instance';
      if (kind === 'release') receipt.source_release_sha = '0'.repeat(40);
      if (kind === 'fleet') receipt.fleet[0].paused = false;
      f.intercept((name) =>
        name === 'fn_ca_get_operator_hold_handoff'
          ? {
              error: kind === 'error' ? { code: 'unreadable' } : null,
              data: kind === 'absent' ? null : receipt,
            }
          : undefined
      );
      f.options.mode = 'resume-first-upgrade';
      await expect(f.run()).rejects.toThrow('original_import_unknown');
      expect(f.calls.map((call) => call.name)).toEqual([
        'fn_ca_import_operator_holds',
        'fn_ca_get_operator_hold_handoff',
      ]);
      f.engine.resumeFromMaintenance();
      expect(f.engine.maintenancePaused).toBe(false);
      expect(f.engine.adminPauseLock).toBe(true);
      expect(f.request('POST', '/admin/resume').result.status).toBe(503);
    }
  );

  it.each(['pid', 'instance', 'handoff', 'module'])(
    'refuses changed %s before any continuation read',
    async (kind) => {
      const f = fixture();
      await f.run();
      f.options.mode = 'resume-first-upgrade';
      if (kind === 'pid') f.options.expectedPid++;
      if (kind === 'instance') f.options.expectedInstanceId = 'other-instance';
      if (kind === 'handoff') f.options.handoffId = generation;
      if (kind === 'module')
        f.modules.client = { supabase: { rpc: f.modules.client.supabase.rpc } };
      const count = f.calls.length;
      await expect(f.run()).rejects.toThrow(
        kind === 'pid' || kind === 'instance' ? 'identity' : 'resume_identity'
      );
      expect(f.calls).toHaveLength(count);
    }
  );

  it('keeps 20s observer deadline and 245s reserve and does not fence new census objects on resume', async () => {
    const f = fixture();
    await f.run();
    f.options.mode = 'resume-first-upgrade';
    const count = f.calls.length;
    f.options.proofDeadline = Date.now() + 21000;
    await expect(f.run()).rejects.toThrow('maintenance_boundary');
    f.options.proofDeadline = Date.now() - 1;
    await expect(f.run()).rejects.toThrow('maintenance_boundary');
    f.options.proofDeadline = Date.now() + 10000;
    f.gs.maintenanceBreak.snapshot = () => ({ remainingMs: 244999 });
    await expect(f.run()).rejects.toThrow('rollback_reserve');
    f.gs.maintenanceBreak.snapshot = () => ({ remainingMs: 300000 });
    const added = new f.Seating('10000000-0000-0000-0000-000000000002');
    f.gs.tableEngines.set(added.tableId, added);
    await expect(f.run()).rejects.toThrow('fleet_changed');
    expect(Object.getOwnPropertyDescriptor(added, 'adminPauseLock')?.value).toBe(false);
    expect(f.calls).toHaveLength(count);
  });

  it('refuses stale native hold version and changed current lease during continuation', async () => {
    const f = fixture();
    await f.run();
    f.options.mode = 'resume-first-upgrade';
    f.intercept((name) =>
      name === 'fn_ca_get_operator_hold_handoff'
        ? {
            error: null,
            data: {
              handoff_id: handoff,
              source_instance: 'test-instance',
              source_release_sha: release,
              fleet: [{ table_id: table, paused: true, lease_generation: generation }],
            },
          }
        : undefined
    );
    f.holds.set(table, { paused: true, version: 2, command_id: null });
    await expect(f.run()).rejects.toThrow('import_readback_mismatch');
    f.holds.set(table, { paused: true, version: 1, command_id: null });
    f.intercept((name) =>
      name === 'fn_ca_get_table_operator_hold'
        ? ((f.engine.currentLease = false), undefined)
        : {
            error: null,
            data: {
              handoff_id: handoff,
              source_instance: 'test-instance',
              source_release_sha: release,
              fleet: [{ table_id: table, paused: true, lease_generation: generation }],
            },
          }
    );
    await expect(f.run()).rejects.toThrow('hold_readback_unknown');
    expect(f.calls.filter((call) => call.name === 'fn_ca_import_operator_holds')).toHaveLength(1);
  });

  it('refuses a continuation while the original import remains in flight', async () => {
    const f = fixture();
    let releaseImport!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    f.intercept((name) =>
      name === 'fn_ca_import_operator_holds' ? pending.then(() => undefined) : undefined
    );
    const original = f.run();
    const resumeOptions = { ...f.options, mode: 'resume-first-upgrade' };
    await expect(
      operatorHoldCheckpointGuard.call(f.gs, resumeOptions, [f.gs], { ...f.modules }, f.http)
    ).rejects.toThrow('resume_in_progress');
    releaseImport();
    await original;
    expect(f.calls.filter((call) => call.name === 'fn_ca_import_operator_holds')).toHaveLength(1);
    expect(f.calls.filter((call) => call.name === 'fn_ca_get_operator_hold_handoff')).toHaveLength(
      0
    );
  });

  it('does not reinterpret missing hold readback as false or change outgoing hold', async () => {
    const f = fixture();
    f.intercept((name) =>
      name === 'fn_ca_get_table_operator_hold'
        ? { error: null, data: { paused: false, version: 0, command_id: null } }
        : undefined
    );
    await expect(f.run()).rejects.toThrow('import_readback_mismatch');
    expect(f.engine.adminPauseLock).toBe(true);
  });

  it('refuses an unverified lease before import', async () => {
    const f = fixture();
    f.engine.engineLeaseVerified = false;
    await expect(f.run()).rejects.toThrow('lease');
    expect(f.calls).toHaveLength(0);
  });

  it('refuses a changed full fleet instead of accepting a truncated snapshot', async () => {
    const f = fixture();
    f.intercept((name) => {
      if (name === 'fn_ca_import_operator_holds')
        f.gs.tableEngines.set(
          '10000000-0000-0000-0000-000000000002',
          new f.Seating('10000000-0000-0000-0000-000000000002')
        );
    });
    await expect(f.run()).rejects.toThrow('fleet_changed');
  });

  it('restores latest cleared authority without clearing maintenance', async () => {
    const f = fixture('rollback');
    f.holds.set(table, {
      paused: false,
      version: 4,
      command_id: '40000000-0000-0000-0000-000000000001',
    });
    const result = await f.run();
    expect(result.phase).toBe('rollback_restored');
    expect(f.engine.adminPauseLock).toBe(false);
    expect(f.engine.maintenancePaused).toBe(true);
    expect(f.calls.every((call) => call.name === 'fn_ca_get_table_operator_hold')).toBe(true);
    f.engine.resumeFromMaintenance();
    expect(f.engine.maintenancePaused).toBe(false);
    await expect(f.engine.dealHand()).resolves.toBe('actual-deal-boundary');
  });

  it('refuses concurrent thaw and deal while the original native restoration is pending', async () => {
    const f = fixture('rollback');
    let releaseRead!: () => void;
    const pending = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    f.intercept(() => pending.then(() => undefined));
    const operation = f.run();
    expect(() => f.engine.resumeFromMaintenance()).toThrow('hold_not_restored');
    await expect(f.engine.dealHand()).rejects.toThrow('hold_not_restored_or_held');
    releaseRead();
    await operation;
    expect(f.engine.maintenancePaused).toBe(true);
  });

  it('refuses future start if lease changes during its one native read', async () => {
    const f = fixture('rollback');
    await f.run();
    const future = new f.Seating();
    f.intercept(() => {
      future.currentLease = false;
    });
    await expect(future.start()).rejects.toThrow('lease');
    expect(future.observedStartHold).toBe(null);
    expect(future.readyValue).toBe(false);
  });

  it('installs boot fences before original listener can listen and before future start', async () => {
    const f = fixture('rollback');
    const result = await installRollbackBootFence(f.options, f.modules);
    expect(result.bootQualified).toBe(false);
    const futureHttp = new f.HttpServer();
    let routed = false;
    futureHttp.on('request', () => {
      routed = true;
    });
    futureHttp.listen(8080);
    const response = {
      status: 0,
      writeHead(status: number) {
        this.status = status;
      },
      end() {},
    };
    futureHttp.emit('request', { method: 'POST', url: '/admin/resume' }, response);
    expect(response.status).toBe(503);
    expect(routed).toBe(false);
    const future = new f.Seating();
    await future.start();
    expect(future.observedStartHold).toBe(true);
  });

  it('is serializable without imported lexical helpers and matches existing start/ownership contracts', async () => {
    const f = fixture('rollback');
    const serialized = Function(`return (${operatorHoldCheckpointGuard.toString()})`)();
    await serialized.call(f.gs, f.options, [f.gs], f.modules, f.http);
    expect(f.engine.adminPauseLock).toBe(true);
    const source = readFileSync('server/src/engine/ServerTableEngineBase.ts', 'utf8');
    expect(source).toContain('private readonly engineLeaseGeneration');
    expect(source).toContain('engineLeaseAuthorityIsCurrent()');
    expect(
      source.indexOf('if (!this.engineLeaseAuthorityIsCurrent())', source.indexOf('async start():'))
    ).toBeLessThan(source.indexOf('this.running = true;', source.indexOf('async start():')));
  });
});
