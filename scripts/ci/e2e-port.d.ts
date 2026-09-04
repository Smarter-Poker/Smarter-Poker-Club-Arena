/**
 * Types for e2e-port.mjs so the Playwright configs (TypeScript) can import it
 * without `any`. The implementation stays .mjs because ci.yml also runs it as
 * a CLI to compute the preview port for a shell step.
 */
export declare function portFor(base: number): number;
