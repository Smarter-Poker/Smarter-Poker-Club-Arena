/** Source-only candidate: actual export readers, exact parser, CSV and auth generation. UNRUN. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKLY_ID as ID, weeklyStatementRow } from '../helpers/clubWeeklyStatement';
const state = vi.hoisted(() => ({
  userId: null as string | null,
  auth: undefined as undefined | ((event: any) => void),
  rows: {} as Record<string, Record<string, unknown>[]>,
  calls: [] as Array<{ table: string; steps: Array<[string, ...unknown[]]> }>,
  reply: null as null | ((table: string, steps: Array<[string, ...unknown[]]>) => Promise<unknown>),
  cap: Infinity,
  ignoreScope: false,
}));
vi.mock('../../src/core/IdentityDNA', () => ({
  getIdentityDNAStatus: () => ({
    loaded: !!state.userId,
    authenticated: !!state.userId,
    userId: state.userId,
  }),
}));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    emit: vi.fn(),
    subscribe: vi.fn((name, fn) => {
      if (name === 'AUTH_STATE_CHANGED') state.auth = fn;
      return vi.fn();
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: vi.fn(async (id) => id) }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn((table: string) => {
      const call = { table, steps: [] as Array<[string, ...unknown[]]> };
      state.calls.push(call);
      const q: any = {};
      for (const method of [
        'select',
        'eq',
        'is',
        'gte',
        'lte',
        'or',
        'order',
        'limit',
        'maybeSingle',
      ])
        q[method] = (...args: unknown[]) => {
          call.steps.push([method, ...args]);
          return q;
        };
      q.then = (done: (value: unknown) => unknown, fail: (error: unknown) => unknown) => {
        if (state.reply) return state.reply(table, call.steps).then(done, fail);
        let rows = [...(state.rows[table] ?? [])];
        for (const [method, key, value] of call.steps) {
          if (method === 'eq' && !state.ignoreScope)
            rows = rows.filter(
              (row) =>
                String(key)
                  .split('.')
                  .reduce((obj: any, part) => obj?.[part], row) === value
            );
          if (method === 'is') rows = rows.filter((row) => row[String(key)] === null);
          if (method === 'gte')
            rows = rows.filter((row) => String(row[String(key)]) >= String(value));
          if (method === 'lte')
            rows = rows.filter((row) => String(row[String(key)]) <= String(value));
          if (method === 'or') {
            const m = /^created_at.lt.([^,]+),and\(created_at.eq.[^,]+,id.lt.([^)]+)\)$/.exec(
              String(key)
            );
            if (m)
              rows = rows.filter(
                (row) =>
                  String(row.created_at) < m[1] ||
                  (row.created_at === m[1] && String(row.id) < m[2])
              );
          }
        }
        if (call.steps.some((s) => s[0] === 'order'))
          rows.sort(
            (a, b) =>
              String(b.created_at).localeCompare(String(a.created_at)) ||
              String(b.id).localeCompare(String(a.id))
          );
        const cap = Math.min(
          state.cap,
          Number(call.steps.find((s) => s[0] === 'limit')?.[1] ?? Infinity)
        );
        rows = rows.slice(0, cap);
        return Promise.resolve({
          data: call.steps.some((s) => s[0] === 'maybeSingle') ? (rows[0] ?? null) : rows,
          error: null,
        }).then(done, fail);
      };
      return q;
    }),
  },
}));
import {
  FinancialExportService as service,
  EXPORT_REPRESENTATIONS,
  type ExportOptions,
  type ExportColumn,
} from '../../src/services/FinancialExportService';
import { exportDecimal, exportInstant } from '../../src/services/FinancialExportContract';
import { resolveClubUUID } from '../../src/utils/clubIdResolver';
import { supabase } from '../../src/lib/supabase';
const AGENT = 'a0000000-0000-0000-0000-000000000001';
const recordId = (n: number) => `f0000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const STAMP = '2026-09-14T12:00:00.000001Z';
function signIn(userId: string | null) {
  state.userId = userId;
  state.auth?.({ payload: { isAuthenticated: !!userId, userId: userId ?? undefined } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const intent = (
  type: ExportOptions['type'],
  extra: Partial<ExportOptions> = {}
): ExportOptions => ({
  type,
  representation: EXPORT_REPRESENTATIONS[type],
  expectedActorId: ID.actor,
  userId: ID.actor,
  isCurrent: () => true,
  periodEnd: '2026-09-15T00:00:00Z',
  ...extra,
});
const commission = (n = 1, extra: Record<string, unknown> = {}) => ({
  id: recordId(n),
  club_id: ID.club,
  user_id: ID.actor,
  amount: '9007199254740993.00001',
  commission_rate: '0.1250',
  source_type: 'legacy_cash',
  source_id: null,
  notes: '=formula()',
  created_at: STAMP,
  settled_at: null,
  ...extra,
});
const wallet = (extra: Record<string, unknown> = {}) => ({
  id: recordId(1),
  user_id: ID.actor,
  wallet_type: 'PLAYER',
  amount: '-12.34',
  type: 'debit',
  category: 'cashout',
  description: null,
  related_entity_id: null,
  table_id: null,
  hand_id: null,
  created_at: STAMP,
  ...extra,
});
beforeEach(() => {
  vi.clearAllMocks();
  state.rows = { agents: [{ id: AGENT, user_id: ID.actor, club_id: ID.club }] };
  state.calls = [];
  state.reply = null;
  state.cap = Infinity;
  state.ignoreScope = false;
  signIn(null);
  signIn(ID.actor);
  vi.mocked(resolveClubUUID)
    .mockReset()
    .mockImplementation(async (value) => value);
});

describe('one exact seven-mode record boundary', () => {
  it.each(['__proto__', 'constructor', 'toString'])(
    'refuses inherited mode names %s before reads',
    async (type) => {
      await expect(
        service.fetchData({ ...intent('wallet_transactions'), type } as ExportOptions)
      ).rejects.toThrow('unknown_export_type');
      expect(state.calls).toEqual([]);
    }
  );
  it.each([{ periodEnd: null }, { limit: null }, { cursor: null }, { cursor: 0 }])(
    'refuses malformed optional input %j rather than selecting defaults',
    async (fault) => {
      await expect(
        service.fetchData({
          ...intent('wallet_transactions'),
          ...fault,
        } as unknown as ExportOptions)
      ).rejects.toThrow();
      expect(state.calls).toEqual([]);
    }
  );
  it('preserves weekly-only invoices and never promotes correction/individual receipts', async () => {
    state.rows.settlement_invoices = [
      weeklyStatementRow(),
      weeklyStatementRow({ invoice_type: 'accounting_correction' }),
      weeklyStatementRow({ invoice_type: 'club_to_agent' }),
    ];
    const p = await service.fetchData(intent('settlement_club', { clubId: ID.club }));
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({
      rake_funding: '100.25',
      paid_by_club: '60.20',
      retained_by_club: '40.05',
    });
    expect(p.coverage).toMatchObject({
      representation: 'club_weekly_summaries',
      pageSize: 1000,
      snapshot: 'not_established',
      continuation: 'possible',
    });
    expect(service.generateCSV(p.columns, p.rows)).not.toContain('accounting_correction');
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
  it('exports only own-agent accrual records with original IDs and unconstrained scale', async () => {
    state.rows.agent_commissions = [commission(), commission(2, { user_id: ID.otherActor })];
    const p = await service.fetchData(
      intent('settlement_agent', { agentId: AGENT, clubId: ID.club.toUpperCase() })
    );
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]).toMatchObject({
      id: recordId(1),
      amount: '9007199254740993.00001',
      commission_rate: '0.1250',
      source_type: 'legacy_cash',
      settled_at: null,
    });
    expect(
      state.calls.some((c) =>
        c.steps.some((s) => s[0] === 'select' && String(s[1]).includes('amount::text'))
      )
    ).toBe(true);
    expect(service.generateCSV(p.columns, p.rows)).toContain("'=formula()");
  });
  it('labels exact per-page commission sums incomplete, even across a single date', async () => {
    state.rows.agent_commissions = [commission(1), commission(2), commission(3)];
    const p = await service.fetchData(
      intent('agent_commissions', { agentId: AGENT, clubId: ID.club, limit: 2 })
    );
    expect(p.rows[0]).toMatchObject({
      page_subtotal: '18014398509481986.00002',
      page_entries: 2,
      source_record_ids: `${recordId(3)};${recordId(2)}`,
      day_coverage: 'Not established; only this source page',
    });
    expect(p.coverage.nextCursor?.id).toBe(recordId(2));
    expect(p.headers).toContain('Page Subtotal (Not Complete Day)');
  });
  it('keeps negative own-wallet cents and refuses a fictitious club scope', async () => {
    state.rows.wallet_transactions = [wallet()];
    const p = await service.fetchData(intent('wallet_transactions'));
    expect(p.rows[0].amount).toBe('-12.34');
    await expect(
      service.fetchData(intent('wallet_transactions', { clubId: ID.club }))
    ).rejects.toThrow('wallet_has_no_club_scope');
  });
  it('keeps raw host-club rake at four places without manufacturing nullable pot/BBJ', async () => {
    state.rows.rake_records = [
      {
        id: recordId(1),
        table_id: null,
        hand_id: null,
        club_id: ID.club,
        is_tournament: true,
        tournament_id: ID.period,
        source: 'legacy_tournament',
        rake_method: 'DEALT_EQUAL',
        pot_size: null,
        rake_amount: '1.2345',
        bbj_contribution: '0.0001',
        created_at: STAMP,
      },
    ];
    const p = await service.fetchData(intent('rake_records', { clubId: ID.club }));
    expect(p.rows[0]).toMatchObject({
      rake_amount: '1.2345',
      pot_size: null,
      bbj_contribution: '0.0001',
      is_tournament: true,
      tournament_id: ID.period,
      source: 'legacy_tournament',
      rake_method: 'DEALT_EQUAL',
    });
    expect(p.headers).toContain('Recorded Host/Bank Club ID');
    state.rows.rake_records[0].is_tournament = 'true';
    await expect(service.fetchData(intent('rake_records', { clubId: ID.club }))).rejects.toThrow(
      'export_boolean_unavailable'
    );
  });
  it('keeps own-player request status separate from a payment/refund receipt', async () => {
    state.rows.cashout_requests = [
      {
        id: recordId(1),
        player_id: ID.actor,
        agent_id: ID.otherActor,
        club_id: ID.club,
        amount: '25.00',
        status: 'approved',
        player_note: null,
        created_at: STAMP,
        completed_at: null,
      },
    ];
    const p = await service.fetchData(intent('cashout_history', { clubId: ID.club }));
    expect(p.rows[0]).toMatchObject({
      status: 'approved',
      agent_id: ID.otherActor,
      completed_at: null,
    });
    expect(p.headers).toContain('Recorded Request State (Not Payment Proof)');
  });
  it('binds credit invoices to exact current own-agent identity without inventing historical club', async () => {
    state.rows.credit_invoices = [
      {
        id: recordId(1),
        agent_id: AGENT,
        period_start: '2026-09-01T00:00:00Z',
        period_end: '2026-09-08T00:00:00Z',
        debt_owed: '9007199254740993.12345',
        amount_paid: '0.00000',
        amount_remaining: '9007199254740993.12345',
        status: 'unpaid',
        due_date: '2026-09-15T00:00:00Z',
        created_at: STAMP,
        agent: { id: AGENT, user_id: ID.actor, club_id: ID.club },
      },
    ];
    const p = await service.fetchData(intent('settlement_invoices', { agentId: AGENT }));
    expect(p.coverage.clubId).toBeNull();
    expect(p.rows[0].debt_owed).toBe('9007199254740993.12345');
    expect(state.calls[state.calls.length - 1]?.steps).toContainEqual([
      'eq',
      'agent.user_id',
      ID.actor,
    ]);
    await expect(
      service.fetchData(intent('settlement_invoices', { agentId: AGENT, clubId: ID.club }))
    ).rejects.toThrow('historical_credit_invoice_club_unproven');
  });
  it.each(['settlement_agent', 'agent_commissions', 'settlement_invoices'] as const)(
    'refuses club-only individual mode %s before any read',
    async (type) => {
      await expect(service.fetchData(intent(type, { clubId: ID.club }))).rejects.toThrow(
        'export_agent_scope_invalid'
      );
      expect(state.calls).toEqual([]);
    }
  );
  it('refuses unsupported legacy representation, missing subject/actor and invalid limits before dispatch', async () => {
    const calls = [
      () => service.fetchData({ type: 'agent_commissions', clubId: ID.club }),
      () => service.fetchData(intent('wallet_transactions', { expectedActorId: undefined })),
      () => service.fetchData(intent('wallet_transactions', { userId: undefined })),
      () => service.fetchData(intent('wallet_transactions', { isCurrent: undefined })),
      () =>
        service.fetchData(intent('cashout_history', { clubId: ID.club, userId: ID.otherActor })),
      ...[0, -1, 1001, 1.5, NaN].map(
        (limit) => () => service.fetchData(intent('wallet_transactions', { limit }))
      ),
    ];
    for (const call of calls) await expect(call()).rejects.toThrow();
    expect(state.calls).toEqual([]);
  });
  it('never substitutes agent PK after a missing/error/wrong-user mapping', async () => {
    for (const reply of [
      { data: null, error: null },
      { data: null, error: { message: 'offline' } },
      { data: { id: AGENT, user_id: ID.otherActor, club_id: ID.club }, error: null },
    ]) {
      state.calls = [];
      state.reply = async () => reply;
      await expect(
        service.fetchData(intent('settlement_agent', { agentId: AGENT, clubId: ID.club }))
      ).rejects.toThrow('export_agent_identity');
      expect(state.calls.map((c) => c.table)).toEqual(['agents']);
    }
  });
  it.each([
    { amount: null },
    { amount: 1.23 },
    { amount: 'NaN' },
    { amount: 'Infinity' },
    { amount: '1.001' },
    { amount: '10000000000000.00' },
    { id: 'wrong' },
    { created_at: '2026-02-30T00:00:00Z' },
  ])('refuses malformed wallet evidence %j without zero substitution', async (fault) => {
    state.rows.wallet_transactions = [wallet(fault)];
    await expect(service.fetchData(intent('wallet_transactions'))).rejects.toThrow();
  });
  it('does not silently omit undated visible history or a failed date probe', async () => {
    state.rows.wallet_transactions = [wallet({ created_at: null })];
    await expect(service.fetchData(intent('wallet_transactions'))).rejects.toThrow(
      'export_undated_history_unavailable'
    );
    state.reply = async () => ({ data: null, error: { message: 'offline' } });
    await expect(service.fetchData(intent('wallet_transactions'))).rejects.toThrow(
      'export_undated_history_unavailable'
    );
  });
  it('refuses a returned wrong scope even when a provider ignores the filter', async () => {
    state.ignoreScope = true;
    state.rows.wallet_transactions = [wallet({ user_id: ID.otherActor })];
    await expect(service.fetchData(intent('wallet_transactions'))).rejects.toThrow(
      'export_returned_scope_mismatch'
    );
  });
  it('uses exact keyset continuation across lower provider caps and timestamp ties without asserting exhaustion', async () => {
    state.rows.wallet_transactions = Array.from({ length: 7 }, (_, i) =>
      wallet({ id: recordId(i + 1) })
    );
    state.cap = 2;
    const ids: string[] = [];
    let cursor: ExportOptions['cursor'];
    for (let i = 0; i < 5; i++) {
      const p = await service.fetchData(intent('wallet_transactions', { limit: 5, cursor }));
      ids.push(...p.rows.map((r) => String(r.id)));
      if (p.coverage.nextCursor) {
        expect(p.coverage.continuation).toBe('possible');
        cursor = p.coverage.nextCursor;
      } else {
        expect(p.coverage.continuation).toBe('range_empty_at_read');
        break;
      }
      expect(p.coverage.snapshot).toBe('not_established');
    }
    expect(ids).toEqual([7, 6, 5, 4, 3, 2, 1].map(recordId));
    expect(new Set(ids).size).toBe(7);
  });
  it('refuses cross-scope cursor reuse, duplicate/backward rows and submillisecond window leaks', async () => {
    state.rows.wallet_transactions = [wallet()];
    const first = await service.fetchData(intent('wallet_transactions'));
    state.calls = [];
    await expect(
      service.fetchData(
        intent('wallet_transactions', {
          cursor: { ...first.coverage.nextCursor!, cutoffBasis: null } as unknown as NonNullable<
            ExportOptions['cursor']
          >,
        })
      )
    ).rejects.toThrow('export_cursor_cutoff_provenance_invalid');
    expect(state.calls).toEqual([]);
    await expect(
      service.fetchData(
        intent('wallet_transactions', { limit: 2, cursor: first.coverage.nextCursor! })
      )
    ).rejects.toThrow('export_cursor_scope_mismatch');
    state.reply = async (_table, steps) => ({
      data: steps.some((s) => s[0] === 'is') ? [] : [wallet(), wallet()],
      error: null,
    });
    await expect(service.fetchData(intent('wallet_transactions'))).rejects.toThrow(
      'export_page_order_or_window_mismatch'
    );
    state.reply = async (_table, steps) => ({
      data: steps.some((s) => s[0] === 'is') ? [] : [wallet()],
      error: null,
    });
    await expect(
      service.fetchData(intent('wallet_transactions', { periodEnd: '2026-09-14T12:00:00.000000Z' }))
    ).rejects.toThrow('export_page_order_or_window_mismatch');
    expect(exportInstant(STAMP) - exportInstant('2026-09-14T12:00:00.000000Z')).toBe(1n);
  });
  it('retains valid midnight date-only semantics and refuses invalid calendar dates', async () => {
    await service.fetchData(
      intent('wallet_transactions', { periodStart: '2026-09-14', periodEnd: '2026-09-15' })
    );
    expect(state.calls[state.calls.length - 1]?.steps).toContainEqual([
      'gte',
      'created_at',
      '2026-09-14T00:00:00Z',
    ]);
    await expect(
      service.fetchData(intent('wallet_transactions', { periodEnd: '2026-02-30' }))
    ).rejects.toThrow('export_timestamp_unavailable');
  });
  it('preserves generated cutoff provenance across continuation and distinguishes a supplied end', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T00:00:00Z'));
    try {
      state.rows.wallet_transactions = [wallet()];
      const client = await service.fetchData(
        intent('wallet_transactions', { periodEnd: undefined })
      );
      expect(client.coverage.cutoffBasis).toBe('client_requested_cutoff');
      expect(client.rows[0].export_cutoff_basis).toBe('client_requested_cutoff');
      const next = await service.fetchData(
        intent('wallet_transactions', { periodEnd: undefined, cursor: client.coverage.nextCursor! })
      );
      expect(next.coverage.createdAtThrough).toBe(client.coverage.createdAtThrough);
      expect(next.coverage.cutoffBasis).toBe('client_requested_cutoff');
      expect((await service.fetchData(intent('wallet_transactions'))).coverage.cutoffBasis).toBe(
        'caller_supplied_cutoff'
      );
    } finally {
      vi.useRealTimers();
    }
  });
  it('preserves wallet references and refuses undated canonical weekly records without reading individual documents', async () => {
    state.rows.wallet_transactions = [
      wallet({ related_entity_id: ID.invoice, table_id: ID.club, hand_id: ID.period }),
    ];
    const w = await service.fetchData(intent('wallet_transactions'));
    expect(w.rows[0]).toMatchObject({
      related_entity_id: ID.invoice,
      table_id: ID.club,
      hand_id: ID.period,
    });
    state.calls = [];
    state.rows.settlement_invoices = [weeklyStatementRow({ created_at: null })];
    await expect(service.fetchData(intent('settlement_club', { clubId: ID.club }))).rejects.toThrow(
      'export_undated_history_unavailable'
    );
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0].steps).toContainEqual(['eq', 'invoice_type', 'club_weekly_accounting']);
    expect(state.calls[0].steps).toContainEqual(['select', 'id']);
  });
  it('holds account ABA across club resolution and across the agent identity read', async () => {
    const alias = deferred<string>();
    vi.mocked(resolveClubUUID).mockReturnValueOnce(alias.promise);
    const first = service.fetchData(intent('rake_records', { clubId: ID.club }));
    signIn(ID.otherActor);
    signIn(ID.actor);
    alias.resolve(ID.club);
    await expect(first).rejects.toThrow('export_account_or_view_changed');
    expect(state.calls).toEqual([]);
    const gate = deferred<unknown>(),
      started = deferred<void>();
    state.reply = async () => {
      started.resolve();
      return gate.promise;
    };
    const second = service.fetchData(
      intent('settlement_agent', { agentId: AGENT, clubId: ID.club })
    );
    await started.promise;
    signIn(ID.otherActor);
    signIn(ID.actor);
    gate.resolve({ data: { id: AGENT, user_id: ID.actor, club_id: ID.club }, error: null });
    await expect(second).rejects.toThrow('export_account_or_view_changed');
    expect(state.calls.map((c) => c.table)).toEqual(['agents']);
  });
  it('does not download after account or view changes during the final record read', async () => {
    const gate = deferred<unknown>(),
      started = deferred<void>();
    let current = true;
    state.reply = async (_table, steps) => {
      if (steps.some((s) => s[0] === 'is')) return { data: [], error: null };
      started.resolve();
      return gate.promise;
    };
    const result = service.exportCSV(intent('wallet_transactions', { isCurrent: () => current }));
    await started.promise;
    current = false;
    signIn(ID.otherActor);
    signIn(ID.actor);
    gate.resolve({ data: [wallet()], error: null });
    expect(await result).toMatchObject({ success: false, error: 'export_account_or_view_changed' });
  });
});

describe('explicit lossless CSV field contract', () => {
  const columns: ExportColumn[] = [
    { key: 'name', label: 'Name', kind: 'text' },
    { key: 'amount', label: 'Amount', kind: 'decimal' },
    { key: 'missing', label: 'Optional', kind: 'text', nullable: true },
  ];
  it('preserves an own prototype-named source field without invoking object setters', () => {
    const row = JSON.parse('{"__proto__":"exact retained text"}') as Record<string, unknown>;
    expect(
      service.generateCSV([{ key: '__proto__', label: 'Source Text', kind: 'text' }], [row])
    ).toBe('"Source Text"\r\n"exact retained text"');
  });
  it('uses declared keys rather than insertion order, retains decimals and quotes text', () => {
    const csv = service.generateCSV(columns, [
      { amount: '9007199254740993.00001', missing: null, name: 'He said "hi"' },
    ]);
    expect(csv).toBe('"Name","Amount","Optional"\r\n"He said ""hi""","9007199254740993.00001",""');
  });
  it.each([
    '=HYPERLINK("x")',
    '+SUM(1,2)',
    '-2+3',
    '@x',
    ' \t=1',
    '\r=1',
    '\n=1',
    '\ttext',
    ' \u0000=1',
    ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code) + 'text'),
    '\u007ftext',
  ])(
    'escapes formula/control-leading free text %j independently from negative numeric values',
    (value) => {
      const csv = service.generateCSV(columns, [{ name: value, amount: '-12.34', missing: null }]);
      expect(csv).toContain('"\'');
      expect(csv).toContain('"-12.34"');
    }
  );
  it('escapes original leading apostrophes too so the text escape is reversible', () => {
    const injected = service.generateCSV(columns, [{ name: '=1', amount: '1.00', missing: null }]);
    const original = service.generateCSV(columns, [{ name: "'=1", amount: '1.00', missing: null }]);
    expect(injected).toContain('"\'=1"');
    expect(original).toContain('"\'\'=1"');
    expect(injected).not.toBe(original);
  });
  it('validates descriptor options before formatting and supports exact scale zero', () => {
    expect(exportDecimal('12.00', 0)).toBe('12');
    for (const scale of [-1, NaN, Infinity, 1.5, 1000000000])
      expect(() => exportDecimal('12', scale)).toThrow('export_decimal_unavailable');
    for (const fault of [
      { scale: -1 },
      { scale: NaN },
      { scale: 1000000000 },
      { integralDigits: 0 },
      { nullable: 'yes' },
      { positive: 1 },
    ]) {
      expect(() =>
        service.generateCSV(
          [{ key: 'amount', label: 'Amount', kind: 'decimal', ...fault }] as ExportColumn[],
          [{ amount: '12' }]
        )
      ).toThrow('export_columns_required');
    }
  });
  it('refuses implicit old column mapping, missing/extra fields and unknown decimal precision', () => {
    expect(() =>
      service.generateCSV(['Name'] as unknown as ExportColumn[], [{ name: 'x' }])
    ).toThrow('export_columns_required');
    expect(() =>
      service.generateCSV(columns, [{ name: 'x', amount: '1.00', missing: undefined }])
    ).toThrow();
    expect(() =>
      service.generateCSV(columns, [{ name: 'x', amount: '1.00', missing: null, extra: 0 }])
    ).toThrow('export_row_shape_unavailable');
    expect(() => exportDecimal('1'.repeat(129))).toThrow('export_decimal_unavailable');
    expect(() => service.downloadCSV('x', 'x.csv')).toThrow('export_account_or_view_changed');
  });
});
