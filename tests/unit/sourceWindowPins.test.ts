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
} from '../helpers/sourceWindow';

describe('a pin bounded by structure cannot be outrun by the code it watches', () => {
  it('takes the whole method however far the body grows', () => {
    const src = ['class X {', '  private go() {', '    const a = 1;', '    return a;', '  }', '}'].join('\n');
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
    const src = ['class X {', '  m(): Promise<{', '    a: 1;', '  }> {', '    KEEP;', '  }', '}'].join('\n');
    expect(sliceMethod(src, 'm(): Promise<{')).toContain('KEEP');
  });

  it('ignores braces inside comments and strings', () => {
    const src = ['class X {', '  m() {', "    const s = '}';", '    // }', '    KEEP;', '  }', '}'].join('\n');
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
    const src = ['broadcast({', "  type: 'available',", '  count: 2,', '});', 'other({ leaked: 1 });'].join('\n');
    const b = sliceEnclosingBlock(src, "type: 'available'");
    expect(b).toContain('count: 2');
    expect(b).not.toContain('leaked');
  });

  it('takes one CSS rule, not a guessed number of characters', () => {
    const css = ['.a {', '  /* a comment that pushes things down */', '  animation: none;', '}', '.b { color: red; }'].join('\n');
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
