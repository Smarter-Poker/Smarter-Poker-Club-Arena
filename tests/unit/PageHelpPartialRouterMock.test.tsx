import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * Page tests mock react-router-dom with a factory that lists only the hooks
 * the page uses. A missing export on such a mock throws when it is read, and
 * PageHelp is on every page now, so it must not read anything the page's own
 * mock did not list.
 */
vi.mock('react-router-dom', () => ({
  useNavigate: () => () => {},
  useParams: () => ({}),
}));

import PageBar from '../../src/components/help/PageBar';

afterEach(cleanup);

describe('the page bar under a partial router mock', () => {
  it('renders and opens its help', () => {
    render(<PageBar title="Player Stats" summary="Your Recorded Hands, Read As Patterns." />);
    fireEvent.click(screen.getByRole('button', { name: 'Page Help' }));
    expect(screen.getByRole('dialog').textContent).toContain('Your Recorded Hands');
  });
});
