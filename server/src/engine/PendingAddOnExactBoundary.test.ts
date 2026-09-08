import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { ServerTableEngine } = await import('./ServerTableEngine.js');
const { supabase } = await import('../services/supabase.js');

const TABLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GENERATION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('protocol-2 pending add-ons have one pre-deal owner', () => {
  it('uses the exact unbound resolver and reflects absolute stack truth', async () => {
    const engine = new ServerTableEngine(TABLE, {
      scope: 'cash',
      verified: true,
      generation: GENERATION,
      proofDeadlineMonotonicMs: performance.now() + 60_000,
    }) as any;
    engine.running = true;
    engine.isCurrentEngine = () => true;
    engine.tableInfo = { id: TABLE, tournament_id: null };
    engine.pendingAddOnSweepNeeded = true;
    engine.getMaxBuyIn = () => 500;
    engine.broadcastCurrentState = vi.fn();
    engine.hub = { emitEvent: vi.fn() };
    const hero = { user_id: 'hero', seat_number: 2, stack: 350 };

    const rpc = vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: {
        ok: true,
        table_id: TABLE,
        lease_generation: GENERATION,
        resolved: 1,
        rows: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            user_id: 'hero',
            kind: 'rebuy',
            applied: '150',
            refunded: '50',
          },
        ],
      },
      error: null,
    } as never);
    vi.spyOn(supabase, 'from').mockReturnValue({
      select: () => ({
        eq: () => ({
          is: () => Promise.resolve({ data: [{ user_id: 'hero', stack: 500 }], error: null }),
        }),
      }),
    } as never);

    await engine.processPendingAddOns([hero]);

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(
      'fn_ca_resolve_unbound_pending_addons',
      expect.objectContaining({
        p_table_id: TABLE,
        p_max_buy_in: 500,
        p_lease_generation: GENERATION,
        p_instance_id: expect.any(String),
      })
    );
    expect(rpc).not.toHaveBeenCalledWith('resolve_pending_addon', expect.anything());
    expect(hero.stack).toBe(500);
    expect(engine.pendingAddOnSweepNeeded).toBe(false);
    expect(engine.hub.emitEvent).toHaveBeenCalledWith(
      TABLE,
      expect.objectContaining({
        type: 'add_on_applied',
        user_id: 'hero',
        amount: 150,
        stack: 500,
        kind: 'rebuy',
      })
    );
  });

  it('fences a dealer whose database authority is gone', async () => {
    const engine = new ServerTableEngine(TABLE, {
      scope: 'cash',
      verified: true,
      generation: GENERATION,
      proofDeadlineMonotonicMs: performance.now() + 60_000,
    }) as any;
    engine.running = true;
    engine.isCurrentEngine = () => true;
    engine.tableInfo = { id: TABLE, tournament_id: null };
    engine.pendingAddOnSweepNeeded = true;
    engine.getMaxBuyIn = () => 500;
    engine.fenceForEngineLeaseLoss = vi.fn();
    const from = vi.spyOn(supabase, 'from');
    vi.spyOn(supabase, 'rpc').mockResolvedValue({
      data: { ok: false, reason: 'lease_lost' },
      error: null,
    } as never);

    await engine.processPendingAddOns([]);

    expect(engine.fenceForEngineLeaseLoss).toHaveBeenCalledWith('pending_addon_lease_lost', true);
    expect(from).not.toHaveBeenCalled();
  });
});

describe('the database boundary excludes accepted-hand rows', () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      '..',
      'supabase',
      'migrations',
      '20260908040000_post_commit_obligations_are_atomic_and_resumable.sql'
    ),
    'utf8'
  );
  const base = readFileSync(join(process.cwd(), 'src/engine/ServerTableEngineBase.ts'), 'utf8');

  it('proves exact authority and shares the processor mutex', () => {
    const resolver = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_resolve_unbound_pending_addons'),
      migration.indexOf(
        '/* The existing worker already has all required crash semantics',
        migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_resolve_unbound_pending_addons')
      )
    );
    expect(resolver).toContain("hashtextextended('hand-post-commit:' || p_table_id::text, 0)");
    expect(resolver).toContain('l.instance_id, l.lease_generation, l.protocol_version');
    expect(resolver).toContain('v_generation IS DISTINCT FROM p_lease_generation');
    expect(resolver).toContain('v_heartbeat < clock_timestamp()');
    expect(resolver).toContain('FOR UPDATE');
    expect(resolver).toContain("c.post_commit_payload #> '{pending_addons,ids}'");
    expect(resolver).toContain('? a.id::text');
    expect(resolver).toContain('public.resolve_pending_addon(v_addon.id, p_max_buy_in)');
  });

  it('sweeps before a quiet table decides it still lacks players', () => {
    const waitLoop = base.slice(
      base.indexOf("this.setLoopPhase('start_wait_for_players')"),
      base.indexOf('// Start dealing loop.')
    );
    const sweep = waitLoop.indexOf('await this.processPendingAddOns(this.seatedPlayers)');
    const minimum = waitLoop.indexOf('this.seatedPlayers.length >= this.minPlayersToDeal()');
    expect(sweep).toBeGreaterThan(-1);
    expect(minimum).toBeGreaterThan(sweep);
  });
});
