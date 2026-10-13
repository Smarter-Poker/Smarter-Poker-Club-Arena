import { describe, it, expect } from 'vitest';
import { functionBody } from './helpers/migrations';
describe('named migration body delimiters', () => {
  it.each(['$$', '$function$', '$named_tag$'])('reads exact requested body with %s', (tag) => {
    const sql =
      'CREATE FUNCTION public.earlier() RETURNS text LANGUAGE sql AS $function$ SELECT 1 $function$;\n' +
      'CREATE FUNCTION public.target() RETURNS text LANGUAGE sql AS ' +
      tag +
      " SELECT 'target' " +
      tag +
      ';\nCREATE FUNCTION public.later() RETURNS text LANGUAGE sql AS $function$ SELECT 2 $function$;';
    expect(functionBody(sql, 'target')).toContain("SELECT 'target'");
    expect(functionBody(sql, 'target')).not.toContain('SELECT 2');
    expect(functionBody(sql, 'target')).not.toContain('SELECT 1');
  });
  it('takes the last actual declaration', () => {
    expect(
      functionBody(
        'CREATE FUNCTION public.target() RETURNS text LANGUAGE sql AS $$ SELECT 1 $$; CREATE OR REPLACE FUNCTION public.target() RETURNS text LANGUAGE sql AS $tag$ SELECT 2 $tag$;',
        'target'
      )
    ).toContain('SELECT 2');
  });
  it('never substitutes a later function for an absent or malformed requested body', () => {
    const later =
      'CREATE FUNCTION public.later() RETURNS text LANGUAGE sql AS $function$ SELECT 2 $function$;';
    expect(() => functionBody(later, 'missing')).toThrow('not declared');
    expect(() =>
      functionBody('CREATE FUNCTION public.target() RETURNS text LANGUAGE sql;' + later, 'target')
    ).toThrow('no dollar-quoted body');
    expect(() =>
      functionBody(
        'CREATE FUNCTION public.target() RETURNS text LANGUAGE sql AS $$ SELECT 1;' + later,
        'target'
      )
    ).toThrow('no closing dollar quote');
  });
});
