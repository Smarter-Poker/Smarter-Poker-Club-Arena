import test from 'node:test';
import assert from 'node:assert/strict';
import {
  selectPoolTab,
  assertSelectedPoolTab,
  clickSelectedPoolControl,
} from './lightning-pilot-selected-pool.mjs';
const pin = { poolSessionId: '10000000-0000-4000-8000-000000000001' };
const left = () => 1000;
function fixture({ matches = 1, visible = true, selected = false } = {}) {
  const calls = [];
  const tab = {
    waitFor: async ({ state, timeout }) => {
      calls.push('wait');
      assert.equal(state, 'visible');
      assert.equal(timeout, 1000);
      if (!visible) throw Error('Unavailable');
    },
    count: async () => matches,
    isVisible: async () => visible,
    tap: async () => {
      calls.push('tap');
      selected = true;
    },
    getAttribute: async (name) => {
      assert.equal(name, 'aria-current');
      return String(selected);
    },
  };
  return {
    calls,
    deselect: () => {
      selected = false;
    },
    page: {
      locator: (selector) => {
        assert.equal(selector, `[data-tabid="${pin.poolSessionId}"]`);
        return tab;
      },
    },
    control: { click: async () => calls.push('action') },
  };
}
test('one normal selection waits for the exact visible pool and verifies selection', async () => {
  const f = fixture(),
    progress = {};
  await selectPoolTab(f.page, pin, left, progress);
  await clickSelectedPoolControl(f.page, pin, f.control, left);
  assert.deepEqual(f.calls, ['wait', 'tap', 'action']);
  assert.equal(progress.selected, true);
  f.deselect();
  await assert.rejects(clickSelectedPoolControl(f.page, pin, f.control, left));
  assert.deepEqual(f.calls, ['wait', 'tap', 'action']);
});
for (const options of [{ matches: 0 }, { matches: 2 }, { visible: false }, { selected: false }]) {
  test(`unproved pool selection refuses a control without selecting or retrying: ${JSON.stringify(options)}`, async () => {
    const f = fixture({ selected: true, ...options });
    await assert.rejects(assertSelectedPoolTab(f.page, pin, left));
    await assert.rejects(clickSelectedPoolControl(f.page, pin, f.control, left));
    assert.deepEqual(f.calls, []);
  });
}
test('malformed pool identity refuses before touching UI', async () => {
  const page = {
    locator: () => {
      throw Error('Must Not Touch UI');
    },
  };
  await assert.rejects(selectPoolTab(page, {}, left, {}), /Explicit Pool/);
  await assert.rejects(assertSelectedPoolTab(page, {}, left), /Explicit Pool/);
});
