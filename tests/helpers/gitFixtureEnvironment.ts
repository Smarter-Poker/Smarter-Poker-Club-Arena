import { devNull } from 'node:os';

/** Only for disposable Git fixtures, never the caller's repository operations. */
export function gitFixtureEnvironment(
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  // Hooks export repository selectors and arbitrary config injection variables.
  // Read them at each invocation and remove the whole namespace before Git runs.
  const env = Object.fromEntries(
    Object.entries(inherited).filter(([name]) => !name.toUpperCase().startsWith('GIT_'))
  );
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: devNull,
    GIT_CONFIG_GLOBAL: devNull,
  };
}
