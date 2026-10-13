import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { isDiamondArenaPlayerPath } from '../../src/components/arena/diamondArenaRoutes';

const source = readFileSync('src/pages/ClubHomePage.tsx', 'utf8');
const ast = ts.createSourceFile(
  'ClubHomePage.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
);
const callbacks: string[] = [];
function visit(node: ts.Node) {
  if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'HouseAdRotator') {
    const attr = node.attributes.properties.find(
      (p) => ts.isJsxAttribute(p) && p.name.getText(ast) === 'onNavigate'
    );
    if (
      attr &&
      ts.isJsxAttribute(attr) &&
      attr.initializer &&
      ts.isJsxExpression(attr.initializer) &&
      attr.initializer.expression
    )
      callbacks.push(attr.initializer.expression.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);

describe('Diamond jackpot advert opens its current asset-owned lobby modal', () => {
  it.each([0, 1])(
    'executes actual lobby advert callback %s without entering a chip route',
    async (index) => {
      expect(callbacks).toHaveLength(2);
      const helper = await import('../../src/components/bbj/diamondJackpotAdvertDoor');
      const navigate = vi.fn();
      const setShowBBJInfo = vi.fn();
      const haptic = { selection: vi.fn() };
      const js = ts.transpileModule(`return (${callbacks[index]});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const make = (automatic: boolean) =>
        new Function(
          'isDiamondJackpotAdvertTarget',
          'isAutomaticArena',
          'clubId',
          'resolvedClubId',
          'club',
          'navigate',
          'setShowBBJInfo',
          'haptic',
          js
        )(
          helper.isDiamondJackpotAdvertTarget,
          automatic,
          'diamond-arena',
          'arena-uuid',
          { id: 'arena-uuid' },
          navigate,
          setShowBBJInfo,
          haptic
        );
      const callback = make(true);
      callback('/clubs/diamond-arena/jackpot');
      callback('/clubs/arena-uuid/jackpot');
      expect(setShowBBJInfo.mock.calls).toEqual([[true], [true]]);
      expect(navigate).not.toHaveBeenCalled();
      callback('/clubs/other-club/jackpot');
      callback('/clubs/diamond-arena/jackpot/admin');
      callback('/diamonds');
      expect(navigate.mock.calls).toEqual([
        ['/clubs/other-club/jackpot'],
        ['/clubs/diamond-arena/jackpot/admin'],
        ['/diamonds'],
      ]);
      make(false)('/clubs/diamond-arena/jackpot');
      expect(navigate).toHaveBeenLastCalledWith('/clubs/diamond-arena/jackpot');
      expect(setShowBBJInfo).toHaveBeenCalledTimes(2);
      expect(haptic.selection).toHaveBeenCalledTimes(6);
      expect(source).toContain("asset={isAutomaticArena ? 'diamonds' : 'chips'}");
      expect(source).toContain('isOpen={showBBJInfo}');
      expect(isDiamondArenaPlayerPath('/clubs/diamond-arena/jackpot')).toBe(false);
    }
  );
});
