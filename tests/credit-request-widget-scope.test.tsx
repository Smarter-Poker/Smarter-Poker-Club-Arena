import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreditRequest } from '../src/services/CreditRequestService';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const mocks = vi.hoisted(() => ({
  userId: 'user-a',
  hydrating: false,
  mine: vi.fn(),
  routed: vi.fn(),
  pending: vi.fn(),
  submit: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  emit: vi.fn(),
  ownerId: 'user-a',
  memberRole: 'owner',
  memberStatus: 'active',
  refresh: undefined as undefined | ((event: { payload: { clubId: string } }) => void),
}));
vi.mock('../src/hooks/useAuthUser', () => ({
  useAuthUser: () => ({ user: { id: mocks.userId }, isHydrating: mocks.hydrating }),
}));
vi.mock('../src/services/CreditRequestService', () => ({
  creditRequestService: {
    getMyRequests: mocks.mine,
    getRequestsForApprover: mocks.routed,
    getPendingForClub: mocks.pending,
    submitRequest: mocks.submit,
    approveRequest: mocks.approve,
    denyRequest: mocks.deny,
  },
}));
vi.mock('../src/components/common/Toast', () => ({ useToast: () => mocks.toast }));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => {
      const query: Record<string, any> = {};
      query.select = query.eq = () => query;
      query.maybeSingle = () =>
        Promise.resolve({
          error: null,
          data:
            table === 'clubs'
              ? { owner_id: mocks.ownerId }
              : { role: mocks.memberRole, status: mocks.memberStatus },
        });
      return query;
    }),
  },
}));
vi.mock('../src/core/MasterBus', () => ({
  masterBus: {
    emit: mocks.emit,
    subscribeDebounced: vi.fn((_name, callback) => {
      mocks.refresh = callback;
      return () => {
        mocks.refresh = undefined;
      };
    }),
  },
}));
import CreditRequestWidget, {
  CreditRequestManagerInbox,
} from '../src/components/agent/CreditRequestWidget';

const props = {
  userId: 'user-a',
  clubId: 'club-a',
  approverUserId: 'parent-user',
  canRequest: true,
  canReview: false,
  currentCreditLimit: 100,
  currentCreditUsed: 25,
};
function request(overrides: Partial<CreditRequest> = {}): CreditRequest {
  return {
    id: 'request-a',
    requesterId: 'user-a',
    requesterName: 'Alice',
    approverId: 'parent-user',
    clubId: 'club-a',
    requestedAmount: 200.25,
    reason: 'Credit limit request',
    status: 'pending',
    createdAt: '2026-09-14T09:00:00Z',
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.userId = 'user-a';
  mocks.hydrating = false;
  mocks.refresh = undefined;
  mocks.ownerId = 'user-a';
  mocks.memberRole = 'owner';
  mocks.memberStatus = 'active';
  mocks.mine.mockResolvedValue([]);
  mocks.routed.mockResolvedValue([]);
  mocks.pending.mockResolvedValue([]);
  mocks.submit.mockResolvedValue(request());
});
afterEach(cleanup);

async function openForm() {
  fireEvent.click(await screen.findByRole('button', { name: '+ Request Credit' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'New Credit Limit' }), {
    target: { value: '200.25' },
  });
}

describe('Credit requests belong to an account and club', () => {
  it('gives a club owner a review inbox without requiring an agent record', async () => {
    mocks.memberRole = 'member';
    mocks.memberStatus = 'active';
    mocks.pending.mockResolvedValue([
      request({ requesterId: 'child-user', approverId: 'previous-owner' }),
    ]);
    render(<CreditRequestManagerInbox clubId="club-a" />);
    expect(await screen.findByRole('button', { name: 'Approve Alice' })).toBeInTheDocument();
    expect(screen.queryByText('Of 0.00')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ Request Credit' })).not.toBeInTheDocument();
    expect(mocks.pending).toHaveBeenCalledWith('club-a', 'user-a');
  });

  it('does not grant credit review to a suspended administrator', async () => {
    mocks.ownerId = 'another-owner';
    mocks.memberRole = 'admin';
    mocks.memberStatus = 'suspended';
    render(<CreditRequestManagerInbox clubId="club-a" />);
    await waitFor(() =>
      expect(screen.queryByText('Checking Credit Request Access...')).not.toBeInTheDocument()
    );
    expect(mocks.routed).not.toHaveBeenCalled();
    expect(mocks.pending).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });
  it('submits account IDs with the selected club and blocks a repeated pending click', async () => {
    const gate = deferred<CreditRequest>();
    mocks.submit.mockReturnValue(gate.promise);
    render(<CreditRequestWidget {...props} />);
    await openForm();
    const submit = screen.getByRole('button', { name: 'Submit Request' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(mocks.mine).toHaveBeenCalledWith('user-a', 'club-a');
    expect(mocks.routed).toHaveBeenCalledWith('user-a', 'club-a');
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.submit).toHaveBeenCalledWith('user-a', {
      approverId: 'parent-user',
      clubId: 'club-a',
      requestedAmount: 200.25,
      reason: 'Credit limit request',
    });
    await act(async () => {
      gate.resolve(request());
      await gate.promise;
    });
    expect(mocks.toast.success).toHaveBeenCalledWith('Credit request submitted');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('refuses a response from another club instead of displaying its amount or requester', async () => {
    mocks.pending.mockResolvedValue([
      request({ clubId: 'club-b', approverId: 'user-a', requesterName: 'Private other club' }),
    ]);
    render(<CreditRequestWidget {...props} canReview />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Credit Requests Could Not Be Loaded.'
    );
    expect(screen.queryByText('Private other club')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
  });

  it('drops an old read after a same-account club switch', async () => {
    const gate = deferred<CreditRequest[]>();
    mocks.mine.mockImplementation((_user, club) =>
      club === 'club-a' ? gate.promise : Promise.resolve([])
    );
    const view = render(<CreditRequestWidget {...props} />);
    await waitFor(() => expect(mocks.mine).toHaveBeenCalled());
    view.rerender(<CreditRequestWidget {...props} clubId="club-b" />);
    await screen.findByRole('button', { name: '+ Request Credit' });
    await act(async () => {
      gate.resolve([request()]);
      await gate.promise;
    });
    expect(screen.queryByText('My Recent Requests')).not.toBeInTheDocument();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });

  it('drops old success after a club switch without clearing the new form', async () => {
    const gate = deferred<CreditRequest>();
    mocks.submit.mockReturnValue(gate.promise);
    const view = render(<CreditRequestWidget {...props} />);
    await openForm();
    fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    view.rerender(<CreditRequestWidget {...props} clubId="club-b" />);
    await openForm();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '300.50' } });
    await act(async () => {
      gate.resolve(request());
      await gate.promise;
    });
    expect(screen.getByRole('spinbutton')).toHaveValue(300.5);
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it('hides pending decisions for a routed parent without club-manager authority', async () => {
    mocks.routed.mockResolvedValue([request({ requesterId: 'child-user', approverId: 'user-a' })]);
    render(<CreditRequestWidget {...props} />);
    expect(
      await screen.findByText('Credit Decisions Require A Club Owner Or Administrator.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).not.toBeInTheDocument();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it('reviews with the account ID, uses the durable receipt and emits no duplicate credit event', async () => {
    const pending = request({ requesterId: 'child-user', approverId: 'previous-owner' });
    mocks.pending.mockResolvedValue([pending]);
    const gate = deferred<CreditRequest>();
    mocks.approve.mockReturnValue(gate.promise);
    render(<CreditRequestWidget {...props} canReview />);
    const approve = await screen.findByRole('button', { name: 'Approve Alice' });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(mocks.approve).toHaveBeenCalledTimes(1);
    expect(mocks.approve).toHaveBeenCalledWith('request-a', 'user-a');
    await act(async () => {
      gate.resolve({ ...pending, status: 'approved', approvedAmount: 200.25 });
      await gate.promise;
    });
    expect(mocks.toast.success).toHaveBeenCalledWith('Credit limit updated to 200.25');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('cannot read or act when the authenticated account no longer matches the caller', async () => {
    mocks.userId = 'user-b';
    render(<CreditRequestWidget {...props} />);
    await act(async () => {});
    expect(mocks.mine).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('rejects fractional cents and a lossy large credit limit before submitting', async () => {
    render(<CreditRequestWidget {...props} />);
    await openForm();
    for (const value of ['1.001', '90071992547409.91', '-1']) {
      fireEvent.change(screen.getByRole('spinbutton'), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: 'Submit Request' }));
    }
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(mocks.toast.error).toHaveBeenCalledTimes(3);
  });
});
