import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

// A native child process with no Vitest, service credential, mocks or .env.
// Refuse network effects and production modules before importing the runtime.
let effects = 0;
const refuse = () => {
  effects++;
  throw new Error('PURE_RUNTIME_EXTERNAL_EFFECT');
};
globalThis.fetch = refuse;
globalThis.setInterval = refuse;
net.Socket.prototype.connect = refuse;
http.request = refuse;
https.request = refuse;
const imports = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    assert.doesNotMatch(
      resolved.url,
      /\/services\/|\/gto\/.*Loader|\/(?:HorseLogic|HorseMind|BrainTelemetry)\.[jt]s|\/(?:localDependencies)\.[jt]s|\/(?:@supabase|@sentry)\//,
      'Pure import reached production dependencies'
    );
    imports.push(resolved.url);
    return resolved;
  },
});

const { HorseDecisionWorkerRuntime } = await import('../workerRuntime.ts');
const { withLocalHorseDecisionServices } = await import('../localServices.ts');
await import('../worker.ts'); // Main-thread import must not load local authority.
const readiness = {
  solverStores: { charts: 0, postflop: 0, postflopV31: 0, postflopV31Dataset: null },
  solverPolicyArtifact: {},
  governor: {},
};
const compute = {
  decide: () => ({ action: 'check', thinkTime: 0 }),
  decideDiscard: () => 0,
  captureDecisionEffects: (fn) => ({ value: fn(), effects: [] }),
  applyDecisionEffects: () => {},
  saveRng: () => 1,
  restoreRng: () => {},
  governorScale: () => 1,
  workerReadiness: () => readiness,
  observeCompletedHand: () => {},
  noteDecision: () => {},
  noteFeature: () => {},
  now: () => 0,
};
// Every service hook refuses effects. Merely constructing the actual LOCAL
// lifecycle composer must leave these hooks untouched as well.
const services = Object.fromEntries(
  [
    'startMindPersistence',
    'stopMindPersistence',
    'startTelemetry',
    'stopTelemetry',
    'startGovernor',
    'stopGovernor',
    'startPolicyLoader',
    'stopPolicyLoader',
    'hydrateMindFromDb',
    'hydrateMind',
    'loadCharts',
    'loadPostflop',
    'loadPostflopV31',
    'startChartLoader',
    'stopChartLoader',
    'startPostflopLoader',
    'stopPostflopLoader',
    'startPostflopV31Loader',
    'stopPostflopV31Loader',
  ].map((name) => [name, refuse])
);
const dependencies = withLocalHorseDecisionServices(compute, services);
new HorseDecisionWorkerRuntime(() => {}, dependencies);
assert.throws(() => new HorseDecisionWorkerRuntime(() => {}), /explicit dependencies/);
const messages = [];
const standalone = new HorseDecisionWorkerRuntime((message) => messages.push(message), {
  ...compute,
  startServices: async () => readiness,
  stopServices: async () => {},
});
await standalone.start();
standalone.receive({ type: 'STATUS', requestId: 1, generation: 1, fence: 'native:pure' });
standalone.receive({ type: 'SHUTDOWN' });
await standalone.drain();
assert.deepEqual(
  messages.map((message) => message.type),
  ['READY', 'STATUS_RESULT', 'STOPPED']
);
assert.equal(effects, 0);
console.log(
  JSON.stringify({
    imported: imports.length,
    externalEffects: effects,
    serviceRolePresent: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    vitestPresent: Boolean(process.env.VITEST),
  })
);
