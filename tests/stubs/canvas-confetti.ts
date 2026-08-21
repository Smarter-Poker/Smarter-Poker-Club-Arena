/**
 * canvas-confetti, stubbed for tests.
 *
 * The real library runs its own requestAnimationFrame loop against a canvas it
 * creates and owns. jsdom keeps firing queued frames after a test unmounts the
 * component that fired the confetti, so the library calls clearRect on a null
 * context and Vitest reports an UNCAUGHT EXCEPTION — the run exits 1 with every
 * assertion green.
 *
 * That is a deploy-blocker, not cosmetic noise: the client suite gates the
 * World Hub bundle publish, so one stray celebration stops shipping for
 * everyone. It has now done so twice, the second time from a test file that a
 * per-file `vi.mock` could not reach because the import is DYNAMIC
 * (`import('canvas-confetti')` inside the component).
 *
 * Aliasing the module in vitest.config.ts is the version that cannot be missed:
 * it covers every test file that exists and every one written later. Confetti
 * is decoration — celebrations are asserted through their phases, classes and
 * sounds, never their pixels — so a no-op loses no coverage.
 */
type ConfettiFn = ((opts?: Record<string, unknown>) => Promise<void>) & {
  reset: () => void;
  create: () => ConfettiFn;
};

const noop = (() => Promise.resolve()) as ConfettiFn;
noop.reset = () => {};
noop.create = () => noop;

export default noop;
