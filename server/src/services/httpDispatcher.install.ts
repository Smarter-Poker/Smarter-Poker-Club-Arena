/**
 * Side-effect module: bound the process-wide HTTP client pool BEFORE any other
 * engine module evaluates. ES modules evaluate imports depth-first in source
 * order, so this must stay the FIRST import of server/src/index.ts - a fetch
 * issued while a later module loads would otherwise dispatch through the
 * unbounded default. The law test pins the position. See httpDispatcher.ts.
 */
import { installBoundedHttpDispatcher } from './httpDispatcher.js';

const outcome = installBoundedHttpDispatcher();
if (outcome.bounded) {
  console.log(
    `[http] global fetch dispatcher bounded: ${outcome.connectionsPerOrigin} connections/origin, keep-alive ${outcome.keepAliveTimeoutMs}ms` +
      (outcome.reason ? ` (${outcome.reason})` : '')
  );
} else {
  console.error(`[http] global fetch dispatcher NOT bounded: ${outcome.reason}`);
}
