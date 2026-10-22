import { describe, expect, it } from 'vitest';
import { toMessageCard } from '@/components/common/newMessageCard';

describe('live new message popup cards', () => {
  it('builds a card from a new_message notification row', () => {
    const card = toMessageCard({
      id: 'n1',
      type: 'new_message',
      title: 'Message from DarthBayter',
      message: 'How do I take a seat',
      data: { conversationId: 'c-1' },
      link: '/hub/messenger?c=c-1',
    });
    expect(card).toEqual({
      id: 'n1',
      sender: 'DarthBayter',
      preview: 'How do I take a seat',
      path: '/hub/messenger?c=c-1',
      avatarUrl: null,
    });
  });

  it('falls back to the conversation id when the row has no messenger link', () => {
    const card = toMessageCard({
      id: 'n2',
      type: 'new_message',
      title: 'Message from KingFish',
      message: 'gg',
      data: { conversation_id: 'c 2' },
      link: '/somewhere-else',
    });
    expect(card?.path).toBe('/hub/messenger?c=c%202');
  });

  it('ignores every other notification type', () => {
    expect(toMessageCard({ id: 'n3', type: 'club_invite_joined', title: 'Joined' })).toBeNull();
    expect(toMessageCard(null)).toBeNull();
  });

  it('shows the sender photo the Hub records, and only from a safe source', () => {
    const base = { id: 'n4', type: 'new_message', title: 'Message from Donkey', message: 'hi' };
    expect(
      toMessageCard({ ...base, data: { senderAvatarUrl: 'https://cdn.example/a.png' } })?.avatarUrl
    ).toBe('https://cdn.example/a.png');
    expect(toMessageCard({ ...base, data: { senderAvatarUrl: '/avatars/b.png' } })?.avatarUrl).toBe(
      '/avatars/b.png'
    );
    expect(
      toMessageCard({ ...base, data: { senderAvatarUrl: 'javascript:alert(1)' } })?.avatarUrl
    ).toBeNull();
    expect(
      toMessageCard({ ...base, data: { senderAvatarUrl: '//evil.example/x' } })?.avatarUrl
    ).toBeNull();
    expect(toMessageCard(base)?.avatarUrl).toBeNull();
  });
});
