import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PreviousHandCard } from '../../src/components/table/PreviousHandCard';

vi.mock('../../src/hooks/useButtonImage', () => ({
  useButtonImage: () => '/previous-hand.png',
}));

afterEach(cleanup);

it('opens saved history after refresh without requiring another completed hand', () => {
  const onTap = vi.fn();
  render(<PreviousHandCard handNumber={null} canReviewHistory onTap={onTap} />);

  fireEvent.click(screen.getByRole('button', { name: 'Previous Hand - Open Hand History' }));

  expect(onTap).toHaveBeenCalledTimes(1);
});

it('keeps the unqualified no-hand entry hidden', () => {
  render(<PreviousHandCard handNumber={null} />);

  expect(screen.queryByRole('button')).toBeNull();
});

it('preserves the numbered entry after a hand completes', () => {
  render(<PreviousHandCard handNumber={123} />);

  expect(
    screen.getByRole('button', { name: 'Previous Hand #123 - Open Hand History' })
  ).toBeTruthy();
});
