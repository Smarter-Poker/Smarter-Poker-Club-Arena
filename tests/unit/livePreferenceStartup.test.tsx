import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { useTopChromeOffset } from '../../src/components/tournament/useTopChromeOffset';
import { useTableArt, TABLE_ART_MAX_COVER_MS } from '../../src/hooks/useTableArt';

afterEach(() => {
  cleanup();
  document.querySelector('#global-header')?.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('measures a lazy header mounted after the former two-second deadline and follows scroll', async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useTopChromeOffset('/clubs/one'));
  await act(() => vi.advanceTimersByTimeAsync(2500));
  const header = document.createElement('header');
  header.id = 'global-header';
  let bottom = 58;
  header.getClientRects = () => [{ height: 58 }] as unknown as DOMRectList;
  header.getBoundingClientRect = () => ({ top: bottom - 58, bottom, height: 58 }) as DOMRect;
  await act(async () => {
    document.body.append(header);
  });
  expect(result.current).toBe(58);
  bottom = 32;
  act(() => document.dispatchEvent(new Event('scroll')));
  expect(result.current).toBe(32);
});

it('does not request or reveal a guessed skin before the saved selection is known', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 100;
      naturalHeight = 100;
      onload: (() => void) | null = null;
      decode = async () => {};
      set src(value: string) {
        requests.push(value);
        queueMicrotask(() => this.onload?.());
      }
    }
  );
  const { result, rerender } = renderHook(
    ({ ready, skin }) => useTableArt(skin, '/saved-room', ready),
    {
      initialProps: { ready: false, skin: '/guessed-felt' },
    }
  );
  expect(requests).toEqual([]);
  expect(result.current.reveal).toBe(false);
  await act(async () => rerender({ ready: true, skin: '/saved-felt' }));
  expect(requests).toEqual(['/saved-felt', '/saved-room']);
  expect(result.current.reveal).toBe(true);
  rerender({ ready: false, skin: '/next-account' });
  expect(result.current.reveal).toBe(false);
  expect(requests).not.toContain('/next-account');
});

it('renders the table loading cover as JSX rather than text inside the stylesheet', () => {
  const source = readFileSync('src/pages/TablePage.tsx', 'utf8');
  const tree = ts.createSourceFile(
    'TablePage.tsx',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let covers = 0;
  const walk = (node: ts.Node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(tree) === 'className' &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      node.initializer.text === 'table-art-cover'
    )
      covers++;
    ts.forEachChild(node, walk);
  };
  walk(tree);
  expect(covers).toBe(1);
});

it('never blocks a live turn indefinitely when saved appearance cannot load', async () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useTableArt('/unsaved-felt', '/unsaved-room', false));
  await act(() => vi.advanceTimersByTimeAsync(TABLE_ART_MAX_COVER_MS));
  expect(result.current.reveal).toBe(true);
  expect(result.current.skinSrc).toBe('');
  expect(result.current.backgroundSrc).toBe('');
});
