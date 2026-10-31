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
    'UPDATE_PRESENCE',
    'REQUEST_HAND_REPLAY',
  ])('refuses participation or unknown operation %s', (type) =>
    expect(isReadOnlySpectatorSocketType(type)).toBe(false)
  );

  it('covers the declared channel observer dialect and foreground probe', () => {
    const text = read('src/services/EngineStateClient.ts');
    const source = ts.createSourceFile('EngineStateClient.ts', text, ts.ScriptTarget.Latest, true);
    const declaration = source.statements.find(
      (node): node is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(node) && node.name.text === 'ChannelClientMessage'
    );
    expect(declaration && ts.isUnionTypeNode(declaration.type)).toBe(true);
    const types = (declaration!.type as ts.UnionTypeNode).types.flatMap((node) => {
      if (!ts.isTypeLiteralNode(node)) return [];
      const field = node.members.find(
        (member): member is ts.PropertySignature =>
          ts.isPropertySignature(member) && member.name.getText(source) === 'type'
      );
      return field?.type &&
        ts.isLiteralTypeNode(field.type) &&
        ts.isStringLiteral(field.type.literal)
        ? [field.type.literal.text]
        : [];
    });
    const reviewedObservers = [
      'JOIN_PRIVATE_RECORD',
      'LEAVE_PRIVATE_RECORD',
      'JOIN_CLUB',
      'LEAVE_CLUB',
      'JOIN_TOURNAMENT',
      'LEAVE_TOURNAMENT',
      'JOIN_LOBBY',
      'LEAVE_LOBBY',
      'PONG',
      'CHANNEL_PONG',
    ];
    const reviewedDenials = ['UPDATE_PRESENCE', 'REQUEST_HAND_REPLAY'];
    expect(types.sort()).toEqual([...reviewedObservers, ...reviewedDenials].sort());
    for (const type of reviewedObservers)
      expect(isReadOnlySpectatorSocketType(type), type).toBe(true);
    for (const type of reviewedDenials)
      expect(isReadOnlySpectatorSocketType(type), type).toBe(false);
    expect(text).toContain("socket.send(JSON.stringify({ type: 'CHANNEL_PING' }))");
    expect(isReadOnlySpectatorSocketType('CHANNEL_PING')).toBe(true);
  });

  it('binds the additional observer operations to actual server handlers', () => {
    const source = ts.createSourceFile(
      'ChannelWebSocketServer.ts',
      read('server/src/transport/ChannelWebSocketServer.ts'),
      ts.ScriptTarget.Latest,
      true
    );
    const expected: Record<string, string[]> = {
      JOIN_PRIVATE_RECORD: ['start', 'catch', 'join'],
      LEAVE_PRIVATE_RECORD: ['leave'],
      CHANNEL_PING: ['sendToUser'],
      CHANNEL_PONG: [],
      PONG: [],
      JOIN_CLUB: ['joinClubIfMember'],
      LEAVE_CLUB: ['cancelClubJoin', 'leaveClub'],
      JOIN_TOURNAMENT: ['joinTournament', 'tournamentHandForHand', 'sendToUser', 'toISOString'],
      LEAVE_TOURNAMENT: ['leaveTournament'],
    };
    const actual: Record<string, string[]> = {};
    const visit = (node: ts.Node) => {
      if (
        ts.isCaseClause(node) &&
        ts.isStringLiteral(node.expression) &&
        Object.hasOwn(expected, node.expression.text)
      ) {
        const names: string[] = [];
        const collect = (child: ts.Node) => {
          if (ts.isCallExpression(child))
            names.push(
              ts.isPropertyAccessExpression(child.expression)
                ? child.expression.name.text
                : child.expression.getText(source)
            );
          ts.forEachChild(child, collect);
        };
        node.statements.forEach(collect);
        actual[node.expression.text] = names;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(actual).toEqual(expected);
  });

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
