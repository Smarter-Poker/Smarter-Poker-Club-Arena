import { expect, it } from 'vitest';
import { HorseLogic } from '../HorseLogic.js';
import { HorseMind } from '../HorseMind.js';
import { horseRangeConsumptionIsValid } from '../HorseRangeConsumptionReceipt.js';
import { workerHarness, decisionRequest } from '../../testing/horseRegression/plan/fixture.js';
import { horseJournalJson } from '../../services/horseDecisionJournal/record.js';
import type { DeepHorseDecisionRequest } from './protocol.js';

it('retains producer-time FAST/DEEP receipts only in the bound private original journal', async () => {
  HorseMind.reset();
  const h = workerHarness({ decide: (...args) => HorseLogic.decide(...args) });
  try {
    const request = decisionRequest();
    const fast = await h.fast(request);
    const original = JSON.parse(horseJournalJson(h.captures.at(-1)!));
    expect(original.rangeConsumption).toMatchObject({
      version: 'horse-range-consumption-v1',
      status: 'observed',
      variant: 'nlh',
      street: 'flop',
    });
    expect(
      horseRangeConsumptionIsValid(
        original.rangeConsumption,
        original.snapshot,
        original.readFrame.sha256
      )
    ).toBe(true);
    expect(JSON.stringify(fast)).not.toContain('rangeConsumption');
    const deep: DeepHorseDecisionRequest = {
      ...request,
      type: 'DECIDE_DEEP',
      requestId: 101,
      rngBefore: fast.rngBefore,
      deepEquity: 2,
    };
    h.runtime.receive(deep);
    await h.runtime.drain();
    const response = h.messages.find((m) => m.type === 'DEEP_RESULT');
    expect(response?.type).toBe('DEEP_RESULT');
    const second = JSON.parse(horseJournalJson(h.captures.at(-1)!));
    expect(second.snapshot.type).toBe('DECIDE_DEEP');
    expect(second.rangeConsumption).toMatchObject({
      version: 'horse-range-consumption-v1',
      status: 'observed',
    });
    expect(second.readFrame.sha256).toBe(original.readFrame.sha256);
    expect(second.rangeConsumption.inputSha256).not.toBe(original.rangeConsumption.inputSha256);
    expect(
      horseRangeConsumptionIsValid(
        second.rangeConsumption,
        second.snapshot,
        second.readFrame.sha256
      )
    ).toBe(true);
    expect(
      horseRangeConsumptionIsValid(
        original.rangeConsumption,
        second.snapshot,
        second.readFrame.sha256
      )
    ).toBe(false);
    expect(
      horseRangeConsumptionIsValid(
        second.rangeConsumption,
        original.snapshot,
        original.readFrame.sha256
      )
    ).toBe(false);
    expect(JSON.stringify(response)).not.toContain('rangeConsumption');
    const unchanged = JSON.parse(horseJournalJson(original));
    expect(unchanged).toEqual(original);
  } finally {
    await h.close();
  }
});

it('does not allocate or pass a range collector when journal capture is disabled', async () => {
  let diagnostic: unknown = 'not-called';
  const h = workerHarness({
    journalEnabled: () => false,
    decide: (...args) => {
      diagnostic = args[5];
      return HorseLogic.decide(...args);
    },
  });
  try {
    await h.fast();
    expect(diagnostic).toBeUndefined();
    expect(h.captures).toHaveLength(0);
  } finally {
    await h.close();
  }
});

it('keeps diagnostic gate failure from changing a real computed action', async () => {
  let gates = 0;
  const h = workerHarness({
    journalEnabled: () => {
      if (++gates === 2) throw Error('diagnostic unavailable');
      return true;
    },
    decide: (...args) => HorseLogic.decide(...args),
  });
  try {
    const fast = await h.fast();
    expect(fast.decision.policyFallback).not.toBe('brain_exception');
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]!.rangeConsumption).toBeUndefined();
  } finally {
    await h.close();
  }
});
