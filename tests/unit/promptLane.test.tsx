/**
 * The prompt lane: one ask on screen at a time (src/lib/promptLane.ts).
 *
 * Found on the first device walkthrough, 2026-09-29: the terms, the age gate,
 * the analytics question and the notifications sheet were all on screen at
 * once, the last two stacked on each other. These tests pin the rule that
 * replaced every prompt's private timer: gates hold, soft asks take turns in
 * a fixed order, the one on screen keeps its turn, and a gate hides it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  resetPromptLaneForTests,
  usePromptTurn,
  useHoldPromptLane,
  type PromptGate,
  type SoftAsk,
} from '../../src/lib/promptLane';

const seen: Record<string, { onScreen: boolean; clear: boolean }> = {};

function Ask({ id, ready }: { id: SoftAsk; ready: boolean }) {
  seen[id] = usePromptTurn(id, ready);
  return null;
}
function Gate({ id, holding }: { id: PromptGate; holding: boolean }) {
  useHoldPromptLane(id, holding);
  return null;
}

function Scene(props: { gate?: boolean; bonus?: boolean; consent?: boolean; push?: boolean }) {
  return (
    <>
      <Gate id="age" holding={!!props.gate} />
      <Ask id="daily-bonus" ready={!!props.bonus} />
      <Ask id="analytics-consent" ready={!!props.consent} />
      <Ask id="push" ready={!!props.push} />
    </>
  );
}

const onScreen = () => (Object.keys(seen) as SoftAsk[]).filter((k) => seen[k].onScreen).sort();

describe('the prompt lane', () => {
  beforeEach(() => {
    cleanup();
    for (const k of Object.keys(seen)) delete seen[k];
    act(() => resetPromptLaneForTests());
  });

  it('shows nothing soft while a gate holds, and nothing is clear', () => {
    render(<Scene gate consent push />);
    expect(onScreen()).toEqual([]);
    expect(seen['push'].clear).toBe(false);
    expect(seen['analytics-consent'].clear).toBe(false);
  });

  it('when the gate lets go, exactly one ask shows - the first in order', () => {
    const view = render(<Scene gate bonus consent push />);
    view.rerender(<Scene bonus consent push />);
    expect(onScreen()).toEqual(['daily-bonus']);
    // Everyone else is told the lane is not clear, so their delays do not run.
    expect(seen['analytics-consent'].clear).toBe(false);
    expect(seen['push'].clear).toBe(false);
  });

  it('turns pass in order as each ask is answered', () => {
    const view = render(<Scene bonus consent push />);
    expect(onScreen()).toEqual(['daily-bonus']);
    view.rerender(<Scene consent push />);
    expect(onScreen()).toEqual(['analytics-consent']);
    view.rerender(<Scene push />);
    expect(onScreen()).toEqual(['push']);
    view.rerender(<Scene />);
    expect(onScreen()).toEqual([]);
    expect(seen['push'].clear).toBe(true);
  });

  it('the ask on screen keeps its turn: an earlier-ordered ask arriving later waits', () => {
    const view = render(<Scene push />);
    expect(onScreen()).toEqual(['push']);
    view.rerender(<Scene push consent />);
    expect(onScreen()).toEqual(['push']);
    view.rerender(<Scene consent />);
    expect(onScreen()).toEqual(['analytics-consent']);
  });

  it('a gate that appears mid-way hides the ask on screen, which comes back after', () => {
    const view = render(<Scene consent />);
    expect(onScreen()).toEqual(['analytics-consent']);
    view.rerender(<Scene gate consent />);
    expect(onScreen()).toEqual([]);
    view.rerender(<Scene consent />);
    expect(onScreen()).toEqual(['analytics-consent']);
  });

  it('a hold is released on unmount, not only on holding=false', () => {
    const view = render(<Scene gate consent />);
    expect(onScreen()).toEqual([]);
    view.rerender(
      <>
        <Ask id="analytics-consent" ready />
      </>
    );
    expect(onScreen()).toEqual(['analytics-consent']);
  });
});
