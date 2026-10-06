/**
 * A FOREIGN KEY INTO CLUBS IS NOT MERGED WITHOUT ITS INDEX.
 *
 * 20260926140858 merged with two club_id keys no index could answer, and every
 * post-deploy certificate failed from 09:41Z on 2026-10-02 until 20261002150335
 * added them. scripts/ci/check-added-club-fk-indexes.mjs now asks the question of
 * the migrations a branch adds, before merge. These cases pin what "an index
 * that can answer the key" means: full (no WHERE), and leading on the column.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { unindexedAddedClubKeys, report } from '../scripts/ci/check-added-club-fk-indexes.mjs';

const EXISTING = [
  {
    file: '20260101000000_existing.sql',
    sql: `CREATE TABLE public.clubs (id uuid PRIMARY KEY);
          CREATE TABLE public.club_notes (id uuid PRIMARY KEY, club_id uuid);
          CREATE INDEX idx_club_notes_club ON public.club_notes (club_id);`,
  },
];
const gaps = (...added: string[]) =>
  unindexedAddedClubKeys({
    existing: EXISTING,
    added: added.map((sql, i) => ({ file: `2026100${i + 1}000000_added.sql`, sql })),
  }).map((g: { table: string; column: string }) => `${g.table}.${g.column}`);

describe('an added foreign key into clubs brings an index that can answer it', () => {
  it('passes a key with a plain index on its column', () => {
    expect(
      gaps(`CREATE TABLE public.receipts (id uuid PRIMARY KEY, club_id uuid NOT NULL REFERENCES public.clubs(id));
            CREATE INDEX idx_receipts_club_id_fk ON public.receipts (club_id);`)
    ).toEqual([]);
  });

  it('fails a key with no index, and tells the author the exact CREATE INDEX', () => {
    const sql = `CREATE TABLE public.receipts (id uuid PRIMARY KEY, club_id uuid NOT NULL REFERENCES clubs(id));`;
    expect(gaps(sql)).toEqual(['public.receipts.club_id']);
    const found = unindexedAddedClubKeys({
      existing: EXISTING,
      added: [{ file: 'supabase/migrations/20261001000000_x.sql', sql }],
    });
    const message = report(found);
    expect(message).toContain('public.receipts (club_id)');
    expect(message).toContain(
      'CREATE INDEX IF NOT EXISTS idx_receipts_club_id_fk ON public.receipts (club_id);'
    );
    expect(message).toContain('supabase/migrations/20261001000000_x.sql');
  });

  it('fails a key whose only index is partial', () => {
    expect(
      gaps(`CREATE TABLE public.receipts (id uuid PRIMARY KEY, club_id uuid REFERENCES public.clubs(id), open boolean);
            CREATE INDEX idx_receipts_open ON public.receipts (club_id) WHERE open;`)
    ).toEqual(['public.receipts.club_id']);
  });

  it('passes a multi-column index that leads on club_id, and fails one that does not', () => {
    const table = `CREATE TABLE public.receipts (id uuid PRIMARY KEY, user_id uuid, club_id uuid REFERENCES public.clubs(id));`;
    expect(gaps(`${table} CREATE INDEX r1 ON public.receipts (club_id, user_id DESC);`)).toEqual(
      []
    );
    expect(gaps(`${table} CREATE UNIQUE INDEX r2 ON public.receipts (user_id, club_id);`)).toEqual([
      'public.receipts.club_id',
    ]);
    expect(
      gaps(
        `CREATE TABLE public.r3 (club_id uuid REFERENCES clubs, user_id uuid, UNIQUE (club_id, user_id));`
      )
    ).toEqual([]);
    expect(
      gaps(
        `CREATE TABLE public.r4 (user_id uuid, club_id uuid REFERENCES clubs, PRIMARY KEY (user_id, club_id));`
      )
    ).toEqual(['public.r4.club_id']);
  });

  it('passes a key whose index is created in a separate added file', () => {
    expect(
      gaps(
        `ALTER TABLE public.club_notes ADD COLUMN owner_club_id uuid REFERENCES public.clubs(id);`,
        `CREATE INDEX IF NOT EXISTS idx_club_notes_owner_club_id_fk ON public.club_notes (owner_club_id);`
      )
    ).toEqual([]);
  });

  it('passes a key on a column an existing repository migration already indexes', () => {
    expect(
      gaps(
        `ALTER TABLE public.club_notes ADD CONSTRAINT club_notes_club_fk FOREIGN KEY (club_id) REFERENCES public.clubs(id);`
      )
    ).toEqual([]);
  });

  it('reads DDL a DO block runs, and ignores SQL inside function bodies and strings', () => {
    expect(
      gaps(`DO $$ BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'x') THEN
                ALTER TABLE public.club_notes ADD COLUMN host_id uuid REFERENCES public.clubs(id);
              END IF;
            END $$;`)
    ).toEqual(['public.club_notes.host_id']);
    expect(
      gaps(`CREATE FUNCTION public.f() RETURNS void LANGUAGE sql AS $fn$ CREATE TABLE t (club_id uuid REFERENCES clubs) $fn$;
            COMMENT ON TABLE public.club_notes IS 'club_id uuid REFERENCES public.clubs(id)';`)
    ).toEqual([]);
  });

  it('does not count a key into some other table', () => {
    expect(
      gaps(
        `CREATE TABLE public.r5 (club_id uuid REFERENCES public.clubs_archive(id), u uuid REFERENCES public.users(id));`
      )
    ).toEqual([]);
  });
});

describe('the migration that stranded the certificate', () => {
  const DIR = resolve(__dirname, '..', 'supabase/migrations');
  const all = readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(resolve(DIR, file), 'utf8') }));
  const at = (version: string) => all.findIndex((m) => m.file.startsWith(version));

  it('is refused alone, and passes once 20261002150335 is added with it', () => {
    const i = at('20260926140858_');
    const j = at('20261002150335_');
    expect(i).toBeGreaterThan(0);
    expect(j).toBeGreaterThan(i);
    const before = all.slice(0, i);
    const alone = unindexedAddedClubKeys({ existing: before, added: [all[i]] });
    expect(alone.map((g: { table: string }) => g.table).sort()).toEqual([
      'public.accounting_legacy_rakeback_certificates',
      'public.accounting_legacy_settlement_legs',
    ]);
    expect(unindexedAddedClubKeys({ existing: before, added: [all[i], all[j]] })).toEqual([]);
  });
});

describe('the gate runs before merge', () => {
  it('is one of the pull-request invariant guards, which check out full history', () => {
    const ci = readFileSync(resolve(__dirname, '..', '.github/workflows/ci.yml'), 'utf8');
    const guards =
      /- name: Invariant guards \(parallel\)[\s\S]*?<<'GUARDS'\n([\s\S]*?)\n\s*GUARDS\n/.exec(ci);
    expect(guards, 'the parallel invariant guard list is missing from ci.yml').toBeTruthy();
    expect(guards![1]).toMatch(/^\s*node scripts\/ci\/check-added-club-fk-indexes\.mjs$/m);
    const job = ci.slice(
      ci.indexOf('\n  typecheck_compile:'),
      ci.indexOf('- name: Invariant guards (parallel)')
    );
    expect(job).toContain("if: github.event_name == 'pull_request'");
    expect(job).toContain('fetch-depth: 0');
  });
});
