import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { useEffect, useLayoutEffect, useState } from 'react';

/**
 * THE COUNT WAS PUBLISHED, THEN WIPED, IN THE SAME COMMIT (2026-09-10).
 *
 * ClubHomePage keeps the number under MY WALLETS in state and lets
 * DynamicWallet publish it from an effect. The page ALSO reset that state to 0
 * from its own effect keyed on the resolved club id. Both effects belong to
 * the commit in which the wallet mounts; React runs a child's effects before
 * its parent's; so the reset always landed after the publish and erased it.
 * Nothing re-published until the wallet's row set changed, which for most
 * viewers it never does, so the placeholder Dan photographed on 2026-09-09
 * was not a slow load - it was the steady state from the day the count
 * shipped. Replacing the placeholder with an empty string (#4003) changed what
 * the wiped plate printed, not the wipe.
 *
 * This file is the mechanism, stated small enough to read: the same parent /
 * child effect shapes, a real React 19 commit, and what the bay prints after
 * it. The law test beside it pins the page itself.
 */
function Child({
  n,
  onChange,
  passive,
}: {
  n: number;
  onChange: (n: number) => void;
  passive?: boolean;
}) {
  const useHook = passive ? useEffect : useLayoutEffect;
  useHook(() => {
    onChange(n);
  }, [onChange, n]);
  return <div>rows</div>;
}

function Page({
  clubId,
  resetsOnClub,
  passive,
}: {
  clubId: string;
  resetsOnClub: boolean;
  passive?: boolean;
}) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (resetsOnClub) setCount(0);
  }, [clubId, resetsOnClub]);
  return (
    <div>
      <small>{count > 0 ? `${count} Balances` : ''}</small>
      <Child n={5} onChange={setCount} passive={passive} />
    </div>
  );
}

const plate = (ui: React.ReactElement) => render(ui).container.querySelector('small')!.textContent;

describe('the wallets count and the club-change reset, in one commit', () => {
  it('a reset keyed on the club wipes the count the wallet just published', () => {
    // The shape that shipped in #2050 and #4003: layout publish, passive reset.
    expect(plate(<Page clubId="club-a" resetsOnClub />)).toBe('');
  });

  it('it wiped the earlier passive publish the same way, which is why the placeholder stuck', () => {
    expect(plate(<Page clubId="club-a" resetsOnClub passive />)).toBe('');
  });

  it('without the reset the published count reaches the plate', () => {
    expect(plate(<Page clubId="club-a" resetsOnClub={false} />)).toBe('5 Balances');
  });
});
