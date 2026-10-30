import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StatsLiveRecords from '../../src/pages/stats/StatsLiveRecords';

const subscribe = vi.hoisted(() => vi.fn());
vi.mock('../../src/hooks/useMasterBusBroadcastChannel', () => ({
  useMasterBusBroadcastChannel: (options: unknown) => subscribe(options),
}));
afterEach(() => {
  cleanup();
  subscribe.mockClear();
});

describe('Stats transaction invalidations', () => {
  it('subscribes once per club and refreshes on committed changes and reconnect', () => {
    const onChange = vi.fn();
    render(
      <StatsLiveRecords
        userId="USER"
        clubIds={['CLUB-A', 'CLUB-B', 'CLUB-A']}
        enabled
        onChange={onChange}
      />
    );
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(subscribe.mock.calls.map(([options]) => options.channelName)).toEqual([
      'member-record:club-a:user',
      'member-record:club-b:user',
    ]);
    const options = subscribe.mock.calls[0][0];
    expect(options.event).toBe('record_changed');
    options.onPayload({});
    options.onSubscriptionStatus('CONNECTING');
    expect(onChange).toHaveBeenCalledTimes(1);
    options.onSubscriptionStatus('SUBSCRIBED');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('does not subscribe for an unverified identity or disabled owner view', () => {
    const { rerender } = render(
      <StatsLiveRecords userId={undefined} clubIds={['club']} enabled onChange={vi.fn()} />
    );
    expect(subscribe).not.toHaveBeenCalled();
    rerender(
      <StatsLiveRecords userId="user" clubIds={['club']} enabled={false} onChange={vi.fn()} />
    );
    expect(subscribe).not.toHaveBeenCalled();
  });
});
