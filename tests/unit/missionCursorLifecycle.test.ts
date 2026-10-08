import { describe, expect, it } from 'vitest';
import { MissionCursorLifecycle } from '../e2e/support/missionCursorLifecycle';

const topic = 'realtime:daily-mission-revision:owned-fixture';
const join = (ref = '1', t = topic) =>
  JSON.stringify([ref, ref, t, 'phx_join', { access_token: 'never-retained' }]);
const reply = (ref = '1', t = topic, status = 'ok') =>
  JSON.stringify([ref, ref, t, 'phx_reply', { status }]);

describe('Mission cursor certification lifecycle evidence', () => {
  it('keeps a healthy twenty-second interval at zero reads and rejects a timer read', () => {
    let now = 0;
    const observation = new MissionCursorLifecycle(topic, () => now);
    observation.begin();
    now = 20000;
    expect(observation.receipt().reads).toBe(0);
    observation.cursorRead();
    expect(observation.receipt().unexplainedReads).toBe(1);
  });

  it('accepts the retained 10-to-11 socket scenario only with a correlated mission rejoin', () => {
    const observation = new MissionCursorLifecycle(topic);
    observation.begin();
    observation.clientMessage(11, join());
    observation.serverMessage(11, reply());
    observation.cursorRead();
    expect(observation.receipt()).toMatchObject({ joins: 1, reads: 1, unexplainedReads: 0 });
    observation.cursorRead();
    expect(observation.receipt().unexplainedReads).toBe(1);
    expect(JSON.stringify(observation.receipt())).not.toContain('never-retained');
    expect(JSON.stringify(observation.receipt())).not.toContain(topic);
  });

  it('never grants credit for unmatched, foreign, failed or duplicate acknowledgments', () => {
    const observation = new MissionCursorLifecycle(topic);
    observation.begin();
    observation.serverMessage(11, reply());
    observation.clientMessage(11, join('2', 'realtime:another-channel'));
    observation.serverMessage(11, reply('2', 'realtime:another-channel'));
    observation.clientMessage(11, join('3'));
    observation.serverMessage(11, reply('3', topic, 'error'));
    observation.clientMessage(11, join('4'));
    observation.serverMessage(12, reply('4'));
    observation.cursorRead();
    expect(observation.receipt().unexplainedReads).toBe(1);
    observation.serverMessage(11, reply('4'));
    observation.serverMessage(11, reply('4'));
    observation.cursorRead();
    observation.cursorRead();
    expect(observation.receipt()).toMatchObject({ joins: 1, reads: 3, unexplainedReads: 2 });
  });

  it('supports object-shaped Phoenix frames and bounds resume event bursts', () => {
    let now = 0;
    const observation = new MissionCursorLifecycle(topic, () => now);
    observation.begin();
    observation.clientMessage(
      1,
      JSON.stringify({ topic, event: 'phx_join', ref: '9', payload: {} })
    );
    observation.serverMessage(
      1,
      JSON.stringify({ topic, event: 'phx_reply', ref: '9', payload: { status: 'ok' } })
    );
    observation.cursorRead();
    observation.resume('visible');
    observation.resume('focus');
    observation.cursorRead();
    now = 1000;
    observation.resume('focus');
    observation.cursorRead();
    expect(observation.receipt()).toMatchObject({
      joins: 1,
      resumes: 2,
      reads: 3,
      unexplainedReads: 0,
    });
  });
});
