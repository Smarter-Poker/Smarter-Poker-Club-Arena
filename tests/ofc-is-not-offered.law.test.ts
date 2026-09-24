/**
 * LAW: OPEN-FACE CHINESE IS NOT OFFERED, AND CRAZY PINEAPPLE IS NEVER CALLED OFC
 * ═══════════════════════════════════════════════════════════════════════════
 * Owner decision, 2026-09-22 (locked): no OFC. Open-Face Chinese is excluded
 * from Club Arena, Crazy Pineapple is never described as OFC, historical
 * records stay exactly as they were written, and current-facing promises of
 * OFC are withdrawn.
 *
 * WHY THIS IS A LAW. The platform never dealt OFC. Every table that carried
 * `ofc_pineapple` was a Crazy Pineapple table wearing the wrong label, and
 * 20260823_retire_ofc_pineapple_variant.sql relabelled them `pineapple`. A
 * month later the hand surfaces' `gameTypeLabel`, Search and Profile still
 * printed "OFC" for the legacy spellings (so the Hand History filter could
 * offer an "OFC" chip), and README still advertised OFC as a game variant. On
 * 2026-09-22 production held 26,840 `pineapple` hands and none whose variant
 * names OFC, so nothing read wrong that day; every one of those surfaces was
 * one legacy row away from naming a game nobody here has ever played.
 *
 * WHAT IS PINNED
 *   1. Each surface that labels a stored variant renders the legacy
 *      `ofc_pineapple` exactly as it renders `pineapple`, and a bare `ofc` as
 *      a label that names no game. Neither ever reads as OFC. Legacy rows are
 *      still labelled, never dropped.
 *   2. No variant label map in src/ or server/src/ carries a value naming OFC.
 *      This is an AST walk over object literals keyed by dealt variants (and
 *      option lists of them), matching words, not substrings of whole files.
 *   3. The playable catalogues (cash picker, tournament and spin catalogues,
 *      and the engine's KNOWN_VARIANTS) have no OFC entry.
 *   4. README lists only variants the engine deals, and names OFC only to say
 *      it is excluded.
 *
 * NOT SCANNED, deliberately: changelogs, audits, migrations and archived docs.
 * They record what happened, including that OFC was once mislabelled, and
 * rewriting history is not how a promise is withdrawn.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { gameTypeLabel } from '../src/utils/handFormat';
import { variantLabel as searchVariantLabel } from '../src/pages/SearchPage';
import { variantDisplay } from '../src/components/lobby/lobbyEntries';
import { toShareVariant } from '../src/lib/shareHandModel';
import {
  CASH_VARIANTS,
  CASH_VARIANT_IDS,
  CASH_VARIANT_LONG,
  isDealtVariant,
} from '../src/config/cashGames';
import {
  SPIN_VARIANT_KEYS,
  TOURNAMENT_GAME_VARIANTS,
  TOURNAMENT_VARIANT_KEYS,
  canRunAsTournament,
} from '../src/config/tournamentVariants';
import { SPIN_GAME_TYPES } from '../src/config/spinSpec';
import { KNOWN_VARIANTS, isKnownVariant } from '../server/src/engine/VariantRules';

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Words, not substrings: `OFC_PINEAPPLE`, `ofc` and `Open-Face` all split into words. */
const words = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** True when the text names Open-Face Chinese, by acronym or by name. */
const namesOfc = (text: string): boolean => {
  const w = words(text);
  return (
    w.includes('ofc') ||
    w.includes('openface') ||
    w.some((word, i) => word === 'open' && w[i + 1] === 'face')
  );
};

/** Lifts a module-level declaration's initializer out of a source file. */
function topLevelInitializers(path: string): {
  sf: ts.SourceFile;
  found: Map<string, ts.Expression>;
} {
  const sf = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map<string, ts.Expression>();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) found.set(d.name.text, d.initializer);
    }
  }
  return { sf, found };
}

/** Types stripped, so a lifted snippet runs as the code the browser runs. */
const toJs = (source: string): string =>
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

/**
 * ProfilePage's own VARIANT_LABEL and variantLabel, executed as written. They
 * are module-private, so the page's source is the only honest way to ask them.
 */
function profileVariantLabel(): (variant: string) => string {
  const { sf, found } = topLevelInitializers('src/pages/ProfilePage.tsx');
  const map = found.get('VARIANT_LABEL');
  const fn = found.get('variantLabel');
  if (!map || !ts.isObjectLiteralExpression(map) || !fn || !ts.isArrowFunction(fn)) {
    throw new Error(
      'ProfilePage no longer declares VARIANT_LABEL and variantLabel at module level. ' +
        'Point this law at whatever now labels the variant breakdown; do not delete the check.'
    );
  }
  const js = toJs(
    `function load() { const VARIANT_LABEL = ${map.getText(sf)}; return ${fn.getText(sf)}; }`
  );
  return new Function(`${js}\nreturn load();`)() as (variant: string) => string;
}

/**
 * The label the Hand History filter chip is given for a variant key: the
 * second argument of the `seen.set(key, ...)` call inside `variantsPresent`,
 * run with the real `gameTypeLabel` the page imports.
 */
function handHistoryChipLabel(): (key: string) => string {
  const path = 'src/pages/HandHistoryPage.tsx';
  const sf = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const importsLabel = sf.statements.some(
    (s) =>
      ts.isImportDeclaration(s) &&
      ts.isStringLiteral(s.moduleSpecifier) &&
      s.moduleSpecifier.text === '../utils/handFormat' &&
      !!s.importClause?.namedBindings &&
      ts.isNamedImports(s.importClause.namedBindings) &&
      s.importClause.namedBindings.elements.some(
        (e) => e.name.text === 'gameTypeLabel' && !e.propertyName
      )
  );
  const chipLabels: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'variantsPresent' &&
      node.initializer
    ) {
      const inner = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'set' &&
          n.arguments.length === 2
        ) {
          chipLabels.push(n.arguments[1]);
        }
        ts.forEachChild(n, inner);
      };
      inner(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!importsLabel || chipLabels.length !== 1) {
    throw new Error(
      'HandHistoryPage no longer labels its variant chips through handFormat.gameTypeLabel ' +
        'inside `variantsPresent`. Point this law at the new chip label; do not delete the check.'
    );
  }
  const js = toJs(`function chip(gameTypeLabel, key) { return (${chipLabels[0].getText(sf)}); }`);
  const chip = new Function(`${js}\nreturn chip;`)() as (
    label: typeof gameTypeLabel,
    key: string
  ) => string;
  return (key) => chip(gameTypeLabel, key);
}

// ─── 1. Every surface that labels a stored variant ────────────────────────────

/**
 * The spellings a stored row can carry. `hand_history.game_variant` and
 * `tables.game_variant` are lower case; `tournaments.game_type` is upper case,
 * and one legacy tournament row still reads OFC_PINEAPPLE.
 */
const LOWER = ['ofc', 'ofc_pineapple'] as const;
const UPPER = ['OFC', 'OFC_PINEAPPLE'] as const;

const SURFACES: ReadonlyArray<{
  name: string;
  label: () => (variant: string) => string;
  spellings: readonly string[];
}> = [
  {
    name: 'handFormat.gameTypeLabel (hand history, replay, hand detail, jackpot surfaces)',
    label: () => (v) => gameTypeLabel(v) ?? '',
    spellings: [...LOWER, ...UPPER],
  },
  {
    name: 'SearchPage variantLabel (tables and tournaments in search)',
    label: () => (v) => searchVariantLabel(v),
    spellings: [...LOWER, ...UPPER],
  },
  {
    // Its keys come from the stats rows' game_variant, which is lower case, and
    // its lookup is case sensitive, so the lower-case spellings are the ones it
    // can be handed.
    name: 'ProfilePage variantLabel (the variant breakdown)',
    label: profileVariantLabel,
    spellings: LOWER,
  },
  {
    name: 'HandHistoryPage variant filter chip',
    label: handHistoryChipLabel,
    spellings: [...LOWER, ...UPPER],
  },
];

describe('no surface that labels a stored variant ever reads as OFC', () => {
  for (const surface of SURFACES) {
    describe(surface.name, () => {
      const label = surface.label();

      it('never names OFC for a legacy spelling', () => {
        const named = surface.spellings
          .map((v) => [v, label(v)] as const)
          .filter(([, text]) => !text || namesOfc(text));
        expect(named).toEqual([]);
      });

      it('reads a legacy ofc_pineapple row as the Crazy Pineapple it was', () => {
        for (const v of surface.spellings.filter((s) => s.toLowerCase() === 'ofc_pineapple')) {
          expect(label(v)).toBe(label(v === v.toUpperCase() ? 'PINEAPPLE' : 'pineapple'));
        }
      });

      it('gives a bare ofc a label that names no game, not a dealt one', () => {
        const dealt = new Set(KNOWN_VARIANTS.map((k) => label(k)));
        for (const v of surface.spellings.filter((s) => s.toLowerCase() === 'ofc')) {
          const text = label(v);
          expect(text.trim()).not.toBe('');
          expect(namesOfc(text)).toBe(false);
          expect(dealt.has(text)).toBe(false);
        }
      });
    });
  }

  it('the lobby and the hand share read a legacy ofc_pineapple as Crazy Pineapple', () => {
    expect(variantDisplay('OFC_PINEAPPLE')).toEqual(variantDisplay('pineapple'));
    expect(variantDisplay('ofc_pineapple')).toEqual(variantDisplay('pineapple'));
    expect(toShareVariant('OFC_PINEAPPLE')).toBe('Crazy Pineapple');
    expect(toShareVariant('ofc_pineapple')).toBe('Crazy Pineapple');
  });
});

// ─── 2. No variant label map carries OFC ──────────────────────────────────────

const DEALT = new Set(KNOWN_VARIANTS.map((k) => k.toLowerCase()));
const keyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;

/** Every string literal at or under `node`. */
function stringsUnder(node: ts.Node): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** Is this object literal an entry of a variant option list (`{ id: 'nlh', label }`)? */
const isVariantOption = (node: ts.Node): boolean =>
  ts.isObjectLiteralExpression(node) &&
  node.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ['id', 'key', 'value', 'variant'].includes(keyName(p.name) ?? '') &&
      ts.isStringLiteralLike(p.initializer) &&
      DEALT.has(p.initializer.text.toLowerCase())
  );

/**
 * The strings in `text` that a variant label map or option list would show a
 * player and that name OFC. A map is an object literal with two or more dealt
 * variants as keys; an option list is an array with two or more `{ id|key:
 * <dealt variant> }` entries. Property NAMES are not read: a legacy spelling
 * may be a key, provided what it maps to is honest.
 */
function ofcLabelsIn(path: string, text: string): string[] {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const findings: string[] = [];
  const at = (n: ts.Node) => `${path}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const assignments = node.properties.filter(ts.isPropertyAssignment);
      const dealtKeys = assignments.filter((p) => DEALT.has((keyName(p.name) ?? '').toLowerCase()));
      if (dealtKeys.length >= 2) {
        for (const p of assignments) {
          for (const s of stringsUnder(p.initializer)) {
            if (namesOfc(s)) findings.push(`${at(p)} ${JSON.stringify(s)}`);
          }
        }
      }
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.filter(isVariantOption).length >= 2) {
      for (const element of node.elements) {
        for (const s of stringsUnder(element)) {
          if (namesOfc(s)) findings.push(`${at(element)} ${JSON.stringify(s)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function sourceFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFilesUnder(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

describe('no variant label map in src/ or server/src/ carries OFC', () => {
  it('the detector sees a map and an option list that name OFC (it is not vacuous)', () => {
    const map = `const M = { nlh: 'NLH', pineapple: 'Pineapple', ofc: 'OFC' };`;
    const list = `const L = [{ id: 'nlh', label: 'NLH' }, { key: 'pineapple', label: 'X' }, { id: 'ofc', label: 'Open Face Chinese' }];`;
    const legacyKeyHonestValue = `const K = { NLH: 'nlh', PINEAPPLE: 'pineapple', OFC_PINEAPPLE: 'pineapple' };`;
    expect(ofcLabelsIn('probe.ts', map)).toEqual(['probe.ts:1 "OFC"']);
    // Both strings of the OFC entry count: its id offers the game, its label names it.
    expect(ofcLabelsIn('probe.ts', list)).toEqual([
      'probe.ts:1 "ofc"',
      'probe.ts:1 "Open Face Chinese"',
    ]);
    expect(ofcLabelsIn('probe.ts', legacyKeyHonestValue)).toEqual([]);
  });

  it('finds none', () => {
    // Reading every file is cheap; parsing is not. Only a file whose text
    // could hold such a label is parsed, and the parse is what decides.
    const mayNameOfc = /ofc|open[\s_-]*face/i;
    const findings = ['src', 'server/src'].flatMap(sourceFilesUnder).flatMap((path) => {
      const text = read(path);
      return mayNameOfc.test(text) ? ofcLabelsIn(relative(ROOT, join(ROOT, path)), text) : [];
    });
    expect(findings).toEqual([]);
  });
});

// ─── 3. The playable catalogues ──────────────────────────────────────────────

describe('no playable catalogue offers OFC', () => {
  const catalogues: ReadonlyArray<[string, readonly string[]]> = [
    ['cash picker ids (src/config/cashGames.ts)', CASH_VARIANT_IDS],
    ['cash picker labels', CASH_VARIANTS.map((v) => v.label)],
    ['cash long names', [...Object.keys(CASH_VARIANT_LONG), ...Object.values(CASH_VARIANT_LONG)]],
    [
      'tournament catalogue (src/config/tournamentVariants.ts)',
      [...Object.keys(TOURNAMENT_GAME_VARIANTS), ...Object.values(TOURNAMENT_GAME_VARIANTS)],
    ],
    ['tournament filter keys', TOURNAMENT_VARIANT_KEYS],
    ['spin catalogue', [...SPIN_GAME_TYPES, ...SPIN_VARIANT_KEYS]],
    ['engine KNOWN_VARIANTS (server/src/engine/VariantRules.ts)', KNOWN_VARIANTS],
  ];

  for (const [name, entries] of catalogues) {
    it(`${name} has entries and none of them is OFC`, () => {
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.filter(namesOfc)).toEqual([]);
    });
  }

  it('no gate admits an OFC spelling as a game', () => {
    for (const v of ['ofc', 'ofc_pineapple', 'OFC', 'OFC_PINEAPPLE']) {
      expect(isKnownVariant(v)).toBe(false);
      expect(isDealtVariant(v)).toBe(false);
      expect(canRunAsTournament(v)).toBe(false);
    }
  });
});

// ─── 4. README ───────────────────────────────────────────────────────────────

describe('README promises only the games the engine deals', () => {
  const lines = read('README.md').split('\n');

  it('its game variant list names only dealt variants, and no OFC', () => {
    const listed = lines.filter((l) => /^\s*[-*]\s+(all\s+)?game variants\s*:/i.test(l));
    expect(listed).toHaveLength(1);
    const items = listed[0]
      .replace(/^[^:]*:/, '')
      .split(/,|\band\b/i)
      .map((item) => item.trim().replace(/[.;]$/, '').trim())
      .filter(Boolean);
    expect(items.length).toBeGreaterThan(0);
    expect(items.filter(namesOfc)).toEqual([]);
    const dealt = new Set(KNOWN_VARIANTS.map((k) => gameTypeLabel(k)));
    expect(items.filter((item) => !dealt.has(item))).toEqual([]);
  });

  it('names OFC only to say it is excluded', () => {
    const promises = lines.filter((l) => namesOfc(l) && !words(l).includes('excluded'));
    expect(promises).toEqual([]);
  });
});
