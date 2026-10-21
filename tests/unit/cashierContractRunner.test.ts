import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  failTelemetryRpc = false;

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
    if (sql.includes('SELECT public.fn_record_cashier_operation')) {
      if (this.failTelemetryRpc) throw new Error('telemetry RPC rejected insert');
      return { rows: [{ recorded: true }] };
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

  it('pins the exact maintained deletion-aware active-member source', () => {
    const migration = readFileSync(
      resolve(
        __dirname,
        '../../supabase/migrations/20261010190307_deleted_accounts_cannot_receive_cashier_transfers.sql'
      ),
      'utf8'
    );
    const body = migration.match(
      /CREATE OR REPLACE FUNCTION public\.fn_cashier_member_is_active[\s\S]*?AS \$function\$([\s\S]*?)\$function\$/
    )?.[1];
    expect(body).toBeDefined();
    expect(body).toContain("p.status='deleted'");
    const hash = createHash('md5').update(body!).digest('hex');
    const pin = readPsqlFreeContract().match(
      /'public\.fn_cashier_member_is_active\(uuid,uuid\)',\s*'hash', '([a-f0-9]+)'/
    )?.[1];
    expect(pin).toBe(hash);
  });

  it('pins only the approved launch boundary addition to the Club Bank read', () => {
    const launch = readFileSync(
      resolve(
        __dirname,
        '../../supabase/migrations/20261012181905_scoped_club_launch_reset_and_guarded_recovery.sql'
      ),
      'utf8'
    );
    const body = launch.match(
      /CREATE OR REPLACE FUNCTION public\.fn_club_money_panel\(p_club_id uuid\)[\s\S]*?AS \$\$([\s\S]*?)\$\$/
    )?.[1];
    expect(body).toBeDefined();
    const boundary =
      "  v_week_start:=public.fn_ca_launch_accounting_start('club',p_club_id,public.fn_ca_launch_accounting_start('union',v_union_id,v_week_start));\n";
    expect(body!.split(boundary)).toHaveLength(2);
    const hash = (value: string) => createHash('md5').update(value).digest('hex');
    const definition = (value: string) =>
      "CREATE OR REPLACE FUNCTION public.fn_club_money_panel(p_club_id uuid)\n RETURNS jsonb\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO 'public', 'extensions'\nAS $function$" +
      value +
      '$function$\n';
    const prior = body!.replace(boundary, '');
    expect(hash(prior)).toBe('ae32bb8e315f339b1ba954325e8cc524');
    expect(hash(definition(prior))).toBe('169793b84386ae10fd03246a96c7d95c');
    const sql = readPsqlFreeContract();
    const entry = sql.match(
      /'signature', 'public\.fn_club_money_panel\(uuid\)',([\s\S]*?)\n {4}\)/
    )?.[1];
    expect(entry).toBeDefined();
    const pin = entry!.match(/'hash', '([a-f0-9]{32})'/)?.[1];
    expect(pin).toBe(hash(definition(body!)));
    // The only accepted alternative is the committed 20261020210238 successor,
    // which restricts agent banks; any other replacement still fails here.
    const successor = readFileSync(
      resolve(
        __dirname,
        '../../supabase/migrations/20261020210238_restrict_agent_banks_and_authorize_downline_reassignment.sql'
      ),
      'utf8'
    ).match(
      /CREATE OR REPLACE FUNCTION public\.fn_club_money_panel\(p_club_id uuid\)[\s\S]*?AS \$function\$([\s\S]*?)\$function\$/
    )?.[1];
    expect(successor).toBeDefined();
    const replacements = [...entry!.matchAll(/'replacement_hash', '([a-f0-9]{32})'/g)].map(
      (match) => match[1]
    );
    expect(replacements).toEqual([hash(definition(successor!))]);
    expect(entry).toContain("'search_path', 'search_path=public, extensions'");
    // A changed actor gate or missing boundary must not satisfy the exact pin.
    expect(hash(definition(body!.replace('IF v_uid IS NULL', 'IF FALSE')))).not.toBe(pin);
    expect(hash(definition(prior))).not.toBe(pin);
    expect(sql).toContain("IF v_actual_hash <> v_item ->> 'hash'");
    expect(sql).toContain("RAISE EXCEPTION 'cashier function drift:");
    expect(sql).toContain("RAISE EXCEPTION 'cashier function ACL drift:");
    expect(sql).toContain("RAISE EXCEPTION 'cashier function is not SECURITY DEFINER:");
  });

  it('pins the exact launch refusal for unfinished prior cashier intents', () => {
    const read = (file: string) =>
      readFileSync(resolve(__dirname, '../../supabase/migrations', file), 'utf8');
    const authority = read('20261004124327_cashier_authority_and_retry_keys_are_exact.sql');
    const body = authority.match(
      /CREATE FUNCTION public\.fn_cashier_exact_intent_begin\([\s\S]*?AS \$function\$([\s\S]*?)\$function\$/
    )?.[1];
    expect(body).toBeDefined();
    const hash = (value: string) => createHash('md5').update(value).digest('hex');
    expect(hash(body!)).toBe('3ec6fc367b3dae5c4bf3978d0175ef22');
    const launch = read('20261012181905_scoped_club_launch_reset_and_guarded_recovery.sql');
    const intent = launch.slice(launch.indexOf('DO $intent$'), launch.indexOf('END $intent$;'));
    const decode = (literal: string) => literal.replaceAll("''", "'").replaceAll('\\n', '\n');
    const needle = decode(intent.match(/needle text:=E'((?:''|[^'])*)'/)![1]);
    const addition = decode(
      intent.match(/EXECUTE replace\(original,needle,E'((?:''|[^'])*)'\|\|needle\)/)![1]
    );
    expect(body!.split(needle)).toHaveLength(2);
    const updated = body!.replace(needle, addition + needle);
    expect(updated.replace(addition, '')).toBe(body);
    expect(addition).toContain(
      'fn_ca_launch_accounting_accepts(v_existing.club_id,v_existing.created_at)'
    );
    // Completed receipts still replay before the new unfinished-request refusal.
    expect(updated.indexOf('v_existing.receipt IS NOT NULL')).toBeLessThan(
      updated.indexOf(addition)
    );
    const sql = readPsqlFreeContract();
    const entry = sql.match(
      /'public\.fn_cashier_exact_intent_begin\(text,uuid,uuid,jsonb\)',([\s\S]*?)\)/
    )![1];
    const pin = entry.match(/'hash', '([a-f0-9]{32})'/)![1];
    expect(pin).toBe(hash(updated));
    expect(entry).toContain("'service_execute', false");
    expect(hash(body!)).not.toBe(pin);
    expect(
      hash(updated.replace('actor_user_id IS DISTINCT FROM v_actor', 'actor_user_id IS NOT NULL'))
    ).not.toBe(pin);
    expect(sql).toContain("RAISE EXCEPTION 'private cashier function ACL drift:");
  });

  it('requires a database credential without printing it', () => {
    expect(() => databaseConfig({})).toThrow('SUPABASE_DB_PASSWORD or SUPABASE_DB_URL');
    const config = databaseConfig({ SUPABASE_DB_PASSWORD: 'not-logged' });
    expect(config).toMatchObject({ port: 6543, password: 'not-logged' });
  });

  it('certifies the same Diamond transfer postimage as the isolated writer qualification', () => {
    const qualification = readFileSync(
      resolve(__dirname, '../sql/run-diamond-transfer-door-and-dr16.py'),
      'utf8'
    );
    const qualifiedHash = qualification.match(
      /SELECT md5\(pg_get_functiondef\('send_wallet_diamond_transfer\(uuid,integer,text,text\)'::regprocedure\)\)"\) == '([a-f0-9]{32})'/
    )?.[1];
    expect(qualifiedHash).toBeDefined();
    const pin = readPsqlFreeContract().match(
      /'public\.send_wallet_diamond_transfer\(uuid,integer,text,text\)',[\s\S]*?'hash', '([a-f0-9]{32})'/
    )?.[1];
    expect(pin).toBe(qualifiedHash);
    const proofs = JSON.parse(
      readFileSync(resolve(__dirname, '../../scripts/ci/migration-live-proofs.json'), 'utf8')
    ).entries;
    const proof = proofs.find(
      (entry: { file: string }) =>
        entry.file === '20261010220349_deleted_players_cannot_transfer_diamonds.sql'
    );
    const migration = readFileSync(resolve(__dirname, '../../supabase/migrations', proof.file));
    expect(createHash('sha256').update(migration).digest('hex')).toBe(proof.sha256);
    expect(proof.proofs.some((sql: string) => sql.includes(`='${qualifiedHash}'`))).toBe(true);
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
    expect(client.queries.some((sql) => sql.includes('fn_record_cashier_operation'))).toBe(true);
    expect(client.queries.at(-1)).toBe('ROLLBACK');
    expect(client.ended).toBe(true);
    vi.restoreAllMocks();
  });

  it('rolls back and closes the connection when the telemetry RPC fails', async () => {
    FakeClient.instances = [];
    class RejectingClient extends FakeClient {
      failTelemetryRpc = true;
    }
    await expect(
      certifyCashierContract({
        environment: { SUPABASE_DB_PASSWORD: 'test' },
        ClientClass: RejectingClient,
      })
    ).rejects.toThrow('telemetry RPC rejected insert');
    const client = FakeClient.instances[0];
    expect(client.queries.at(-1)).toBe('ROLLBACK');
    expect(client.ended).toBe(true);
  });
});
