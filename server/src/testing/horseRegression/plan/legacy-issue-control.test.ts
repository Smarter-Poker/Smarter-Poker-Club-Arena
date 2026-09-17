import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HorseMind } from '../../../engine/HorseMind.js';
import { HorseDecisionWorkerRuntime } from '../../../engine/horseDecision/workerRuntime.js';
import { horsePlanBatchBindingFromRequest } from '../../../engine/HorsePlanHandIdentity.js';
import { requestAt, workerHarness } from './fixture.js';

beforeEach(() => HorseMind.reset());
afterEach(() => HorseMind.reset());
describe('current worker refuses unissued commits', () => {
  it('does not apply or ACK an unissued effect batch', async () => {
    const seam = workerHarness(),
      messages: any[] = [];
    // This helper constructs caller input; the real worker emitted no issue.
    const runtime = new HorseDecisionWorkerRuntime(
      (message: unknown) => messages.push(message),
      seam.deps
    );
    try {
      const request = requestAt();
      runtime.receive({
        type: 'COMMIT_DECISION_EFFECTS',
        requestId: 2,
        generation: request.generation,
        fence: request.fence,
        planBinding: horsePlanBatchBindingFromRequest(request),
        effects: [
          {
            type: 'plan',
            handKey: 'never-issued',
            userId: request.player.user_id,
            barrelIntent: true,
          },
        ],
      } as any);
      await runtime.drain();
      expect(seam.applied()).toBe(0);
      expect(messages.at(-1).type).toBe('ERROR');
    } finally {
      runtime.receive({ type: 'SHUTDOWN' });
      await runtime.drain();
      await seam.close();
    }
  });
});
