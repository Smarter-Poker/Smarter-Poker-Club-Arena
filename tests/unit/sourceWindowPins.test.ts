/**
 * The helper that bounds every source pin has to be pinned itself.
 *
 * Both regressions below were REAL, found on 2026-08-28 while moving the
 * brace-matcher out of tournamentRakeAndBreaks into tests/helpers and running
 * the suites against it. The original version silently returned a window
 * containing the signature and nothing else for any method with an inline
 * return type - which is the failure that stays GREEN while guarding nothing.
 */
import { describe, it, expect } from 'vitest';
import {
  sliceMethod,
  sliceCall,
  sliceBlockAfter,
  sliceEnclosingBlock,
  sliceCssRule,
  sliceSqlStatement,
  sliceDollarQuoted,
  sliceStatement,
  sliceYamlBlock,
  sliceBetween,
} from '../helpers/sourceWindow';

describe('a pin bounded by structure cannot be outrun by the code it watches', () => {
  it('takes the whole method however far the body grows', () => {
    const src = [
      'class X {',
      '  private go() {',
      '    const a = 1;',
      '    return a;',
      '  }',
      '}',
    ].join('\n');
    const body = sliceMethod(src, 'private go(');
    expect(body).toContain('return a;');
    expect(body).not.toContain('class X');
  });

  it('REGRESSION: an inline return type does not truncate the window', () => {
    // `Promise<{ ... }>` puts a brace between the signature and the body, and
    // a naive brace-matcher closes on it. This shape is ServerTableEngine's
    // revealRabbitHunt, where it hid three assertions behind a green tick.
    const src = [
      'class X {',
      '  public async reveal(',
      '    userId: string',
      '  ): Promise<{',
      '    success: boolean;',
      '  }> {',
      "    const charge = await rpc('fn_consume');",
      '    return { success: true };',
      '  }',
      '}',
    ].join('\n');
    const body = sliceMethod(src, 'public async reveal(');
    expect(body, 'the window stopped at the return type').toContain('fn_consume');
  });

  it('REGRESSION: `}> {` at the signature indent is not the closing line', () => {
    const src = [
      'class X {',
      '  m(): Promise<{',
      '    a: 1;',
      '  }> {',
      '    KEEP;',
      '  }',
      '}',
    ].join('\n');
    expect(sliceMethod(src, 'm(): Promise<{')).toContain('KEEP');
  });

  it('ignores braces inside comments and strings', () => {
    const src = [
      'class X {',
      '  m() {',
      "    const s = '}';",
      '    // }',
      '    KEEP;',
      '  }',
      '}',
    ].join('\n');
    expect(sliceMethod(src, 'm() {')).toContain('KEEP');
  });

  it('takes a call with all of its arguments, however many fields appear', () => {
    const src = 'await registerMtt({ a: 1, b: 2, nested: { c: 3 } }, second);';
    const call = sliceCall(src, 'registerMtt(');
    expect(call).toContain('c: 3');
    expect(call).toContain('second');
    expect(call.endsWith(')')).toBe(true);
  });

  it('takes the block a condition opens, not the function around it', () => {
    const src = ["if (eventType === 'x') {", '  INSIDE;', '}', 'OUTSIDE;'].join('\n');
    const b = sliceBlockAfter(src, "eventType === 'x'");
    expect(b).toContain('INSIDE');
    expect(b).not.toContain('OUTSIDE');
  });

  it('takes the innermost block around a needle, so a negative assertion stays honest', () => {
    // The point of the innermost bound: a fixed forward window would run past
    // this object into the next one and read the very field it asserts absent.
    const src = [
      'broadcast({',
      "  type: 'available',",
      '  count: 2,',
      '});',
      'other({ leaked: 1 });',
    ].join('\n');
    const b = sliceEnclosingBlock(src, "type: 'available'");
    expect(b).toContain('count: 2');
    expect(b).not.toContain('leaked');
  });

  it('takes one CSS rule, not a guessed number of characters', () => {
    const css = [
      '.a {',
      '  /* a comment that pushes things down */',
      '  animation: none;',
      '}',
      '.b { color: red; }',
    ].join('\n');
    const rule = sliceCssRule(css, '.a {');
    expect(rule).toContain('animation: none');
    expect(rule).not.toContain('color: red');
  });

  it('says so loudly when the anchor is gone, rather than passing on an empty window', () => {
    expect(() => sliceMethod('class X {}', 'nope(')).toThrow(/not found/);
    expect(() => sliceCall('const a = 1;', 'nope(')).toThrow(/not found/);
    expect(() => sliceCssRule('.a {}', '.nope')).toThrow(/not found/);
  });
});

describe('SQL pins are bounded by the statement, not by a byte count', () => {
  const MIG = [
    'CREATE OR REPLACE FUNCTION public.f()',
    'RETURNS void',
    'LANGUAGE plpgsql',
    'SECURITY DEFINER',
    'SET search_path = public, pg_temp',
    'AS $$',
    'BEGIN',
    '  PERFORM 1; PERFORM 2;',
    'END;',
    '$$;',
    'CREATE POLICY "p" ON t FOR INSERT WITH CHECK (user_id = auth.uid());',
  ].join('\n');

  it('does not stop at a semicolon inside a dollar-quoted body', () => {
    const fn = sliceSqlStatement(MIG, 'CREATE OR REPLACE FUNCTION public.f()');
    expect(fn).toContain('SET search_path = public, pg_temp');
    expect(fn).toContain('PERFORM 2;');
    expect(fn.trimEnd().endsWith('$$;')).toBe(true);
    expect(fn).not.toContain('CREATE POLICY');
  });

  it('ends a plain statement at its own semicolon', () => {
    const pol = sliceSqlStatement(MIG, 'CREATE POLICY "p"');
    expect(pol).toContain('auth.uid()');
    expect(pol.trimEnd().endsWith(');')).toBe(true);
  });

  it('takes a dollar-quoted block by its matching tag', () => {
    const src = 'DO $preflight$ BEGIN RAISE; END $preflight$; AFTER;';
    const b = sliceDollarQuoted(src, '$preflight$');
    expect(b).toContain('RAISE');
    expect(b).not.toContain('AFTER');
  });
});

describe('statement and YAML pins are bounded by their own shape', () => {
  it('takes a declaration to its semicolon, not a guessed prefix', () => {
    const src = "const S = new Set(['nlh', 'plo; not really']);\nconst OTHER = 'plo';";
    const d = sliceStatement(src, 'const S =');
    expect(d).toContain("'nlh'");
    expect(d).not.toContain('OTHER');
  });

  it('takes a YAML job by indentation, however many keys it gains', () => {
    const y = [
      'jobs:',
      '  build:',
      '    needs: prep',
      '    env:',
      '      A: 1',
      '  other:',
      '    needs: nope',
    ].join('\n');
    const b = sliceYamlBlock(y, '  build:');
    expect(b).toContain('needs: prep');
    expect(b).toContain('A: 1');
    expect(b).not.toContain('nope');
  });
});

describe('a section is bounded by the section after it', () => {
  it('runs from one marker to the next, not for N characters', () => {
    const sql = [
      '-- GUARD 1: kill switch',
      "  IF x THEN RETURN 'disabled'; END IF;",
      '-- GUARD 2: other',
      "  RETURN 'other';",
    ].join('\n');
    const g1 = sliceBetween(sql, 'GUARD 1', 'GUARD 2');
    expect(g1).toContain("'disabled'");
    expect(g1).not.toContain("'other'");
  });
});

describe('prose about a method can never be mistaken for the method', () => {
  /**
   * The regression that produced this suite, 2026-09-05. A comment added to
   * `releasePauseGate()` mentioned `resumeDealing()` by name; every scanner
   * anchored with a raw `indexOf`, so the pin on resumeDealing sliced the
   * comment's owner instead and two correct methods went red. The client suite
   * publishes the bundle, so a pin that can be broken by documentation is a pin
   * that can stop the estate from shipping.
   */
  const SRC = [
    'class Engine {',
    '  /**',
    '   * Both resumeFromMaintenance() and resumeDealing() funnel through here.',
    '   */',
    '  private releasePauseGate(): void {',
    '    this.holdBeforeNextHand = false;',
    '  }',
    '',
    '  private resumeDealing(): void {',
    '    if (this.maintenancePaused) return;',
    '    this.releasePauseGate();',
    '  }',
    '}',
  ].join('\n');

  it('sliceMethod anchors on the definition, not on a comment naming it', () => {
    const body = sliceMethod(SRC, 'resumeDealing()');
    expect(body).toContain('if (this.maintenancePaused) return;');
    expect(body).toContain('this.releasePauseGate();');
    // The give-away of the bug: the comment's owner leaking into the window.
    expect(body).not.toContain('this.holdBeforeNextHand = false;');
  });

  it('a string literal cannot anchor a pin either', () => {
    const src = [
      'class X {',
      '  private log(): void {',
      "    console.log('go() was called');",
      '    const decoy = 1;',
      '  }',
      '',
      '  private go(): void {',
      '    const real = 2;',
      '  }',
      '}',
    ].join('\n');
    const body = sliceMethod(src, 'go()');
    expect(body).toContain('const real = 2;');
    expect(body).not.toContain('const decoy = 1;');
  });

  it('NEGATIVE assertions are the dangerous half: a comment window forbids nothing', () => {
    // A pin anchored on the comment would read a window with no `await` in it
    // and pass forever, which is the silent direction this file exists to stop.
    const src = [
      'class X {',
      '  /** unsafeWrite() must never await inside the lock. */',
      '  private describe(): void {',
      '    const note = 1;',
      '  }',
      '',
      '  private unsafeWrite(): void {',
      '    await this.db.commit();',
      '  }',
      '}',
    ].join('\n');
    const body = sliceMethod(src, 'unsafeWrite()');
    expect(body).toContain('await this.db.commit();');
  });

  it('the fallback keeps string anchors working - a CSS selector, a SQL fragment', () => {
    // Anchors that legitimately ARE text must still resolve, or this change
    // would break more than it fixed.
    expect(sliceCssRule('.a { color: red; }', '.a')).toContain('color: red');
    expect(sliceSqlStatement('CREATE INDEX i ON t (c);', 'CREATE INDEX')).toContain('ON t (c);');
  });

  it('occurrence counting skips comment mentions, so index 0 is the first REAL one', () => {
    const src = [
      'const x = {',
      '  // seatCount: 9 is the old default',
      '  seatCount: 6,',
      '};',
    ].join('\n');
    expect(sliceEnclosingBlock(src, 'seatCount:', 0)).toContain('seatCount: 6');
  });
});
