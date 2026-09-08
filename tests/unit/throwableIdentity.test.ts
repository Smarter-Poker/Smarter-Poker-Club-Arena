import { describe, expect, it, vi } from 'vitest';
import { isThrowableEventId, magicEightBallAnswer } from '../../src/throwables/identity';
import { roomService } from '../../src/services/RoomService';

describe('shared throwable identity', () => {
  it('accepts UUID metadata and rejects malformed or oversized values', () => {
    expect(isThrowableEventId('AA110000-0000-4000-8000-000000000001')).toBe(true);
    for (const value of [
      null,
      {},
      12,
      '',
      'not-a-receipt',
      'x'.repeat(10000),
      'aa110000-0000-4000-1000-000000000001',
    ]) {
      expect(isThrowableEventId(value)).toBe(false);
    }
  });

  it('chooses a stable answer across clients, independent of clock and UUID case', () => {
    const id = 'AA110000-0000-4000-8000-000000000001';
    const answer = magicEightBallAnswer(id);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1);
    expect(magicEightBallAnswer(id.toLowerCase())).toEqual(answer);
    clock.mockReturnValue(999999999);
    expect(magicEightBallAnswer(id)).toEqual(answer);
    clock.mockRestore();
    const answers = new Set(
      Array.from({ length: 100 }, (_, i) =>
        magicEightBallAnswer(`aa110000-0000-4000-8000-${String(i).padStart(12, '0')}`).join(' ')
      )
    );
    expect(answers.size).toBe(3);
  });

  it('preserves legacy message text while adding the shared ID as separate metadata', async () => {
    const send = vi.fn().mockResolvedValue('ok');
    const channel = { on: vi.fn().mockReturnThis(), send };
    roomService.registerChannel('identity-test', channel as never);
    const id = 'aa110000-0000-4000-8000-000000000001';
    try {
      await roomService.sendChat('identity-test', 'sender', '[THROW:magic_8_ball:2]', id);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'broadcast',
          event: 'game_event',
          payload: expect.objectContaining({
            sender: 'sender',
            payload: { message: '[THROW:magic_8_ball:2]', throwId: id },
          }),
        })
      );
      await roomService.sendChat('identity-test', 'sender', 'hello');
      expect(send.mock.calls[1][0].payload.payload).toEqual({ message: 'hello' });
    } finally {
      await roomService.leaveRoom('identity-test');
    }
  });
});
