/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - ONLY A PERSON MOVES THE ARENA SWITCHES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 10 of the Diamond Arena programme, line 5, "without arena-wide
 * automatic lockout": item 9 of the ordered build list in
 * docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md. The arena's two switches,
 * ca_arena_settings.cash_games_enabled and tournaments_enabled, are Dan's. The
 * engine reads them and refuses a closed kind of game; nothing turns them on
 * or off by itself, so no alarm, watch or door can lock the arena. That is
 * true today, and this pins it.
 *
 * It fails if a migration defines a function that writes either switch - a
 * trigger, a watch, a door, a cron body, or a body built by substitution
 * inside a string - or if the engine's runtime source (server/src) writes
 * ca_arena_settings at all. A migration's own statement, top level or in its
 * DO block, runs once when a person applies it; that is a person moving the
 * switch and is not refused here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';
import { runtimeFilesMatching } from './helpers/runtimeSourceSearch';

const SWITCH = /\b(?:cash_games_enabled|tournaments_enabled)\b/i;
const sqlCode = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

/** Does this SQL write a switch? */
const writesASwitch = (sql: string): boolean => {
  const s = sqlCode(sql);
  for (const m of s.matchAll(
    /\bupdate\s+(?:only\s+)?(?:public\.)?ca_arena_settings\b(?:\s+(?:as\s+)?(?!set\b)\w+)?\s+set\b([\s\S]*?)(?:\bwhere\b|\breturning\b|\bfrom\b|;|$)/gi
  )) {
    if (SWITCH.test(m[1])) return true;
  }
  for (const m of s.matchAll(
    /\b(?:insert|merge)\s+into\s+(?:public\.)?ca_arena_settings\b([^;]*)/gi
  )) {
    if (SWITCH.test(m[1])) return true;
  }
  return /\bnew\s*\.\s*(?:cash_games_enabled|tournaments_enabled)\s*:=/i.test(s);
};

/**
 * Every part of a migration that can run later: each function body and each
 * string literal, at any depth. A migration's own code - top level, or the
 * code of a DO block - runs once, when a person applies it, and is left out.
 */
const laterCode = (sql: string): string[] => {
  const out: string[] = [];
  const scan = (src: string) => {
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '-' && src[i + 1] === '-') {
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? src.length : nl + 1;
      } else if (c === '/' && src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end < 0 ? src.length : end + 2;
      } else if (c === "'") {
        const escapes = /[eE]/.test(src[i - 1] ?? '') && !/\w/.test(src[i - 2] ?? '');
        let j = i + 1;
        let text = '';
        while (j < src.length) {
          if (escapes && src[j] === '\\') {
            text += src.slice(j, j + 2);
            j += 2;
          } else if (src[j] === "'" && src[j + 1] === "'") {
            text += "'";
            j += 2;
          } else if (src[j] === "'") {
            break;
          } else {
            text += src[j];
            j += 1;
          }
        }
        out.push(text);
        i = j + 1;
      } else if (c === '$' && /^\$[A-Za-z_]*\$/.test(src.slice(i, i + 64))) {
        const tag = /^\$[A-Za-z_]*\$/.exec(src.slice(i, i + 64))![0];
        const start = i + tag.length;
        const end = src.indexOf(tag, start);
        const body = end < 0 ? src.slice(start) : src.slice(start, end);
        if (/\bdo\s*$/i.test(src.slice(Math.max(0, i - 16), i))) scan(body);
        else out.push(body);
        i = end < 0 ? src.length : end + tag.length;
      } else {
        i += 1;
      }
    }
  };
  scan(sql);
  return out;
};

const flagged = (sql: string) => laterCode(sql).some(writesASwitch);

describe('LAW: only a person moves the arena switches', () => {
  it('the detector sees a function that writes a switch, and nothing else', () => {
    const fn = (body: string) =>
      `CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $f$ BEGIN ${body}; END $f$;`;
    expect(
      flagged(fn('UPDATE public.ca_arena_settings SET tournaments_enabled = false WHERE id = 1'))
    ).toBe(true);
    expect(
      flagged(
        fn(
          'UPDATE ca_arena_settings s SET updated_at = now(), cash_games_enabled = NOT s.cash_games_enabled'
        )
      )
    ).toBe(true);
    expect(
      flagged(
        fn(
          'INSERT INTO public.ca_arena_settings (id, cash_games_enabled) VALUES (1, false) ON CONFLICT (id) DO UPDATE SET cash_games_enabled = false'
        )
      )
    ).toBe(true);
    expect(
      flagged(
        'CREATE FUNCTION public.t() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.tournaments_enabled := false; RETURN NEW; END $$;'
      )
    ).toBe(true);
    // a body built by substitution, and a cron job, live in strings
    expect(
      flagged(
        "DO $m$ BEGIN v_new := v_old || 'UPDATE public.ca_arena_settings SET cash_games_enabled = false;'; EXECUTE replace(v_def, v_old, v_new); END $m$;"
      )
    ).toBe(true);
    expect(
      flagged(
        "SELECT cron.schedule('lock', '* * * * *', $$UPDATE public.ca_arena_settings SET tournaments_enabled = false$$);"
      )
    ).toBe(true);
    // a read, another column, and a person's own statement are not
    expect(
      flagged(fn('SELECT tournaments_enabled INTO v FROM public.ca_arena_settings WHERE id = 1'))
    ).toBe(false);
    expect(
      flagged(
        fn('UPDATE public.ca_arena_settings SET club_id = v_club WHERE NOT tournaments_enabled')
      )
    ).toBe(false);
    expect(
      flagged('UPDATE public.ca_arena_settings SET cash_games_enabled = true WHERE id = 1;')
    ).toBe(false);
    expect(
      flagged(
        'DO $m$ BEGIN UPDATE public.ca_arena_settings SET cash_games_enabled = true WHERE id = 1; END $m$;'
      )
    ).toBe(false);
  });

  it('no migration defines a function that writes cash_games_enabled or tournaments_enabled', () => {
    const corpus = migrationCorpus();
    // the switches are the columns this law is about
    expect(
      corpus.some((m) =>
        /ALTER TABLE public\.ca_arena_settings\s+ADD COLUMN cash_games_enabled\b/.test(m.sql)
      )
    ).toBe(true);
    expect(
      corpus.some((m) =>
        /ALTER TABLE public\.ca_arena_settings\s+ADD COLUMN (?:IF NOT EXISTS )?tournaments_enabled\b/.test(
          m.sql
        )
      )
    ).toBe(true);
    const mentioning = corpus.filter((m) => SWITCH.test(m.sql));
    expect(mentioning.length).toBeGreaterThan(20);
    const offenders = mentioning.filter((m) => flagged(m.sql)).map((m) => m.name);
    expect(offenders).toEqual([]);
  });

  it('the engine reads the settings row and never writes it', () => {
    const files = runtimeFilesMatching(
      [resolve(__dirname, '..', 'server', 'src')],
      /ca_arena_settings/
    );
    let reads = 0;
    for (const path of files) {
      const src = readFileSync(path, 'utf8');
      expect(src, path).not.toMatch(
        /\b(?:update|insert\s+into|delete\s+from|merge\s+into|truncate(?:\s+table)?)\s+(?:only\s+)?(?:public\.)?ca_arena_settings\b/i
      );
      for (const m of src.matchAll(/(['"`])ca_arena_settings\1/g)) {
        const end = src.indexOf(';', m.index);
        const chain = src.slice(m.index, end < 0 ? undefined : end);
        expect(chain, path).not.toMatch(/\.\s*(?:update|insert|upsert|delete)\s*\(/);
        if (/\.\s*select\s*\(/.test(chain)) reads += 1;
      }
    }
    // not vacuous: the engine's two readers of the switches are still there
    expect(reads).toBeGreaterThanOrEqual(2);
  });
});
