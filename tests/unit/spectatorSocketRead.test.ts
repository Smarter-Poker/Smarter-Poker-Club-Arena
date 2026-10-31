import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { isReadOnlySpectatorSocketType } from '../e2e/support/spectatorSocketRead';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('production observer socket boundary', () => {
  it('accepts the actual lobby subscription lifecycle without participation', () => {
    expect(isReadOnlySpectatorSocketType('JOIN_LOBBY')).toBe(true);
    expect(isReadOnlySpectatorSocketType('LEAVE_LOBBY')).toBe(true);
    const source = ts.createSourceFile(
      'ChannelWebSocketServer.ts',
      read('server/src/transport/ChannelWebSocketServer.ts'),
      ts.ScriptTarget.Latest,
      true
    );
    const calls: Record<string, string[]> = {};
    const visit = (node: ts.Node) => {
      if (
        ts.isCaseClause(node) &&
        ts.isStringLiteral(node.expression) &&
        ['JOIN_LOBBY', 'LEAVE_LOBBY'].includes(node.expression.text)
      ) {
        const names: string[] = [];
        const collect = (child: ts.Node) => {
          if (ts.isCallExpression(child)) names.push(child.expression.getText(source));
          ts.forEachChild(child, collect);
        };
        node.statements.forEach(collect);
        calls[node.expression.text] = names;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(calls).toEqual({
      JOIN_LOBBY: ['channelHub.joinLobby', 'channelHub.sendLobbyUpdateTo'],
      LEAVE_LOBBY: ['channelHub.leaveLobby'],
    });
  });

  it.each([
    'ACTION',
    'JOIN_TABLE',
    'BUY_IN',
    'ADD_CHIPS',
    'LEAVE_TABLE',
    '',
    'join_lobby',
    'UNKNOWN',
  ])('refuses participation or unknown operation %s', (type) =>
    expect(isReadOnlySpectatorSocketType(type)).toBe(false)
  );

  it('wires both actual affected observers to the same boundary', () => {
    for (const name of ['production-seat-move-announcement', 'production-row-channel-owners']) {
      const source = read(`tests/e2e/${name}.spec.ts`);
      expect(source).toContain("from './support/spectatorSocketRead'");
      expect(source).toContain('if (!isReadOnlySpectatorSocketType(type))');
    }
  });

  it('refuses every synthetic upstream frame before the natural observer allowlist', () => {
    const source = read('tests/e2e/production-seat-move-announcement.spec.ts');
    const handler = source.slice(source.indexOf('client.onMessage((message) => {'));
    expect(handler).toMatch(
      /if \(syntheticPhase\) \{\s*refusedSynthetic.websocket\+\+;\s*return;\s*\}/
    );
    expect(handler.indexOf('if (syntheticPhase)')).toBeLessThan(
      handler.indexOf('if (!isReadOnlySpectatorSocketType(type))')
    );
  });
});
