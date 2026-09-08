import React from 'react';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/services/ThrowableService', () => ({
  getThrowableImageUrl: (id: string, size: number) => `/sized/${id}/${size}`,
  getThrowableRawUrl: (id: string) => `/raw/${id}`,
  throwableService: { getThrowables: () => [] },
}));
vi.mock('../../src/services/ThrowableCutout', () => ({
  peekThrowableCutout: () => null,
  getThrowableCutout: () => new Promise(() => {}),
}));
import { ThrowableImage } from '../../src/components/table/ThrowableImage';
afterEach(cleanup);
describe('throwable image identity', () => {
  it('restarts the fallback ladder when a reused cell changes item or size', () => {
    const { container, rerender } = render(<ThrowableImage throwableId="beer" size={84} />);
    fireEvent.error(container.querySelector('img')!);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    rerender(<ThrowableImage throwableId="trophy" size={84} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/sized/trophy/84');
    fireEvent.error(container.querySelector('img')!);
    rerender(<ThrowableImage throwableId="trophy" size={128} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/sized/trophy/128');
  });
});
