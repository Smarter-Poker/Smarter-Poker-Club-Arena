import { describe, expect, it, vi } from 'vitest';

import {
  certifyCashierContract,
  databaseConfig,
  readPsqlFreeContract,
} from '../../scripts/verification-harness/certify-cashier-contract.mjs';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const CLUB_ID = '00000000-0000-4000-8000-000000000002';

class FakeClient {
  static instances: FakeClient[] = [];
  queries: string[] = [];
  connected = false;
  ended = false;
  failInsert = false;

  constructor(public configuration: unknown) {
    FakeClient.instances.push(this);
  }

  async connect() {
    this.connected = true;
  }

  async query(sql: string) {
    this.queries.push(sql);
    if (sql.includes('FROM public.club_members cm')) {
      return { rows: [{ user_id: USER_ID, club_id: CLUB_ID }] };
    }
    if (this.failInsert && sql.includes('INSERT INTO public.cashier_operations')) {
      throw new Error('policy rejected insert');
    }
    return { rows: [] };
  }

  async end() {
    this.ended = true;
  }
}

describe('cashier database contract runner', () => {
  it('removes the one supported psql directive from the SQL contract', () => {
    const sql = readPsqlFreeContract();
    expect(sql).not.toContain('\\set ON_ERROR_STOP');
    expect(sql).toContain('md5(pg_get_functiondef(v_oid))');
  });

  it('requires a database credential without printing it', () => {
    expect(() => databaseConfig({})).toThrow('SUPABASE_DB_PASSWORD or SUPABASE_DB_URL');
    const config = databaseConfig({ SUPABASE_DB_PASSWORD: 'not-logged' });
    expect(config).toMatchObject({ port: 6543, password: 'not-logged' });
  });

  it('executes both contracts and always rolls the authenticated canary back', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    FakeClient.instances = [];
    await certifyCashierContract({
      environment: { SUPABASE_DB_PASSWORD: 'test' },
      ClientClass: FakeClient,
    });
    const client = FakeClient.instances[0];
    expect(client.connected).toBe(true);
    expect(client.queries).toContain('BEGIN');
    expect(client.queries).toContain('SET LOCAL ROLE authenticated');
    expect(
      client.queries.some((sql) => sql.includes('INSERT INTO public.cashier_operations'))
    ).toBe(true);
    expect(client.queries.at(-1)).toBe('ROLLBACK');
    expect(client.ended).toBe(true);
    vi.restoreAllMocks();
  });

  it('rolls back and closes the connection when the RLS insert fails', async () => {
    FakeClient.instances = [];
    class RejectingClient extends FakeClient {
      failInsert = true;
    }
    await expect(
      certifyCashierContract({
        environment: { SUPABASE_DB_PASSWORD: 'test' },
        ClientClass: RejectingClient,
      })
    ).rejects.toThrow('policy rejected insert');
    const client = FakeClient.instances[0];
    expect(client.queries.at(-1)).toBe('ROLLBACK');
    expect(client.ended).toBe(true);
  });
});
