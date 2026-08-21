import '@testing-library/jest-dom';

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock localStorage with actual storage
const localStorageData: Record<string, string> = {};

const localStorageMock = {
  getItem: (key: string) => localStorageData[key] ?? null,
  setItem: (key: string, value: string) => {
    localStorageData[key] = value;
  },
  removeItem: (key: string) => {
    delete localStorageData[key];
  },
  clear: () => {
    for (const key in localStorageData) {
      delete localStorageData[key];
    }
  },
  key: (index: number) => {
    const keys = Object.keys(localStorageData);
    return keys[index] ?? null;
  },
  get length() {
    return Object.keys(localStorageData).length;
  },
};

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Mock Sentry
vi.mock('@sentry/react', () => ({
  captureException: vi.fn(),
  withErrorBoundary: (component: any) => component,
  withScope: vi.fn((callback) => callback({ setContext: vi.fn() })),
  showReportDialog: vi.fn(),
}));

// Mock Supabase
//
// TEST-INFRA FIX 2026-08-15: `from: vi.fn()` returns UNDEFINED, so the very
// common `supabase.from('x').select('y').eq(...)` threw "Cannot read
// properties of undefined (reading 'select')" the moment any service touched
// the database. Individual suites worked around it by re-mocking the module
// themselves; the ones that did not, died.
//
// This builds a chainable PostgREST-shaped stub: every filter/modifier returns
// the same builder, and the builder is thenable, so it resolves to
// `{ data: [], error: null }` whether the caller awaits the chain directly, or
// calls .single() / .maybeSingle() first. Suites that need specific rows still
// override with their own vi.mock — this only stops the default from crashing.
vi.mock('../src/lib/supabase', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      signUp: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      resetPasswordForEmail: vi.fn(() => Promise.resolve({ data: {}, error: null })),
      signOut: vi.fn(() => Promise.resolve({ error: null })),
      getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
    from: vi.fn(() => {
      const result = { data: [], error: null, count: 0, status: 200, statusText: 'OK' };
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      for (const method of [
        'select',
        'insert',
        'update',
        'upsert',
        'delete',
        'eq',
        'neq',
        'gt',
        'gte',
        'lt',
        'lte',
        'like',
        'ilike',
        'is',
        'in',
        'contains',
        'containedBy',
        'rangeGt',
        'rangeLt',
        'overlaps',
        'match',
        'not',
        'or',
        'filter',
        'order',
        'limit',
        'range',
        'abortSignal',
        'returns',
      ]) {
        builder[method] = vi.fn(chain);
      }
      builder.single = vi.fn(() => Promise.resolve({ data: null, error: null }));
      builder.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: null }));
      // Thenable, so `await supabase.from('x').select('y').eq(...)` resolves
      // without the caller having to call .single() first.
      builder.then = (resolve: (v: typeof result) => unknown) =>
        Promise.resolve(result).then(resolve);
      return builder;
    }),
    rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
    channel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = vi.fn(() => ch);
      ch.subscribe = vi.fn((cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      });
      ch.unsubscribe = vi.fn(() => Promise.resolve('ok'));
      ch.send = vi.fn(() => Promise.resolve('ok'));
      return ch;
    }),
    removeChannel: vi.fn(() => Promise.resolve('ok')),
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(() => Promise.resolve({ data: null, error: null })),
        download: vi.fn(() => Promise.resolve({ data: null, error: null })),
        getPublicUrl: vi.fn(() => ({ data: { publicUrl: '' } })),
        remove: vi.fn(() => Promise.resolve({ data: null, error: null })),
      })),
    },
  },
}));

// Mock MasterBus
//
// TEST-INFRA FIX 2026-08-15: this mock used to expose exactly three methods —
// emit, on, off — and TWO OF THOSE DO NOT EXIST on the real MasterBusCore. The
// real surface is subscribe / emit / subscribeDebounced / getOrCreateChannel /
// removeRegisteredChannel / onEvent / init / reset / ... Any module that
// subscribes at import time (AchievementTriggerService does, at module scope)
// therefore threw `masterBus.subscribe is not a function` while the test file
// was still being collected, which fails the WHOLE SUITE before a single test
// runs. That is the single largest cause of the red suite: the code was fine
// and the harness was lying about it.
//
// Mirrors the real contract where it matters: subscribe() returns an
// unsubscribe function, and getOrCreateChannel() returns a chainable channel.
vi.mock('../src/core/MasterBus', () => ({
  masterBus: {
    init: vi.fn(() => ({ online: true })),
    // The real subscribe returns an unsubscribe function. Handing back
    // undefined made every `const off = masterBus.subscribe(...)` + `off()`
    // cleanup throw on unmount.
    subscribe: vi.fn(() => vi.fn()),
    subscribeDebounced: vi.fn(() => vi.fn()),
    emit: vi.fn(),
    onEvent: vi.fn(() => vi.fn()),
    executeOptimistic: vi.fn(async (_e: unknown, _p: unknown, fn: () => unknown) => fn?.()),
    getOrCreateChannel: vi.fn(() => {
      const ch: Record<string, unknown> = {};
      ch.on = vi.fn(() => ch);
      ch.subscribe = vi.fn((cb?: (s: string) => void) => {
        cb?.('SUBSCRIBED');
        return ch;
      });
      ch.unsubscribe = vi.fn(() => Promise.resolve('ok'));
      ch.send = vi.fn(() => Promise.resolve('ok'));
      ch.track = vi.fn(() => Promise.resolve('ok'));
      ch.presenceState = vi.fn(() => ({}));
      return ch;
    }),
    removeRegisteredChannel: vi.fn(),
    registerChannelFactory: vi.fn(),
    removeChannelFactory: vi.fn(),
    hasChannel: vi.fn(() => false),
    getChannelCount: vi.fn(() => 0),
    getStatus: vi.fn(() => ({ online: true })),
    isOnline: vi.fn(() => true),
    reset: vi.fn(),
    getDiagnostics: vi.fn(() => ({ subscribers: {}, channels: [], eventLog: [] })),
    getEventLog: vi.fn(() => []),
    clearEventLog: vi.fn(),
  },
  // Some modules import the hook rather than the singleton.
  useMasterBusSubscription: vi.fn(),
}));

// Mock framer-motion with proper React.createElement
vi.mock('framer-motion', async () => {
  const React = await vi.importActual('react');
  const actual = await vi.importActual('framer-motion');

  return {
    ...actual,
    /**
     * EVERY tag, not just div and button.
     *
     * This mock used to list two elements. `motion.section`, `motion.li`,
     * `motion.span` and friends therefore resolved to `undefined`, and React
     * threw "Element type is invalid... got: undefined" the moment a component
     * used one — which reads like a broken export and sent people hunting in
     * entirely the wrong file. It also failed the file at LOAD time, and since
     * the client suite gates the World Hub bundle publish, one component using
     * motion.section stopped shipping for everyone.
     *
     * A Proxy answers for any tag that is asked for, so this can never be
     * out of date again. Framer-only props are stripped so React does not warn
     * about unknown DOM attributes.
     */
    motion: new Proxy(
      {},
      {
        get: (_target, tag: string) => {
          const Component = ({ children, ...props }: any) => {
            const {
              initial: _i,
              animate: _a,
              exit: _e,
              transition: _t,
              variants: _v,
              whileHover: _wh,
              whileTap: _wt,
              whileInView: _wi,
              viewport: _vp,
              layout: _l,
              layoutId: _lid,
              drag: _d,
              dragConstraints: _dc,
              ...domProps
            } = props;
            return React.createElement(String(tag), domProps, children);
          };
          Component.displayName = `motion.${String(tag)}`;
          return Component;
        },
      }
    ),
    AnimatePresence: (props: any) => props.children,
    useReducedMotion: () => false,
  };
});
