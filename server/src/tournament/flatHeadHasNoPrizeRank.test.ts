/**
 * A FLAT HEAD IS NOT A PRIZE DRAW (2026-10-05).
 *
 * Before the mystery phase opens, a mystery event pays the flat head on every
 * knockout (`fn_collect_bounty` mode `mystery_pre`). The engine used to rank
 * that head against a ladder of flat heads - rank 1 every time - and send it
 * as `prizeRank` on `bounty_collected`, so the table announced
 * "X Just Pulled The Top Mystery Bounty" for every routine bust.
 *
 * Only a chest has a rung. This reads the production source so the rank
 * cannot be put back on the head path without this test seeing it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = readFileSync(
  join(process.cwd(), 'src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const ast = ts.createSourceFile('eliminations.ts', source, ts.ScriptTarget.Latest, true);

/** Every object literal passed as the payload of `broadcast('<event>', {...})`. */
function broadcastPayloads(event: string): ts.ObjectLiteralExpression[] {
  const found: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'broadcast' &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === event &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      found.push(node.arguments[1]);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return found;
}

function propertyNames(obj: ts.ObjectLiteralExpression): string[] {
  return obj.properties
    .map((p) => (p.name && ts.isIdentifier(p.name) ? p.name.text : ''))
    .filter(Boolean);
}

describe('a flat bounty head carries no prize rank', () => {
  it('bounty_collected is broadcast, and never with a prizeRank', () => {
    const payloads = broadcastPayloads('bounty_collected');
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(propertyNames(payload)).not.toContain('prizeRank');
    }
  });

  it('the chest reveal still carries its rank', () => {
    const payloads = broadcastPayloads('mystery_bounty_revealed');
    expect(payloads.length).toBeGreaterThan(0);
    expect(payloads.some((p) => propertyNames(p).includes('prizeRank'))).toBe(true);
  });

  it('the pre-phase ladder that ranked flat heads is gone', () => {
    expect(source).not.toMatch(/preMysteryPrizeRank/);
  });
});
