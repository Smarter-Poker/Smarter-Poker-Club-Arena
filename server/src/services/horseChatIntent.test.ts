/**
 * WHAT A PLAYER SAID, READ THE WAY A PERSON AT THE TABLE WOULD (2026-10-24)
 *
 * Every "real" case below is a line a player actually typed in production
 * table chat (read 2026-10-24); before this change no horse answered any.
 */
import { describe, expect, it } from 'vitest';
import { addressedHorse, chatWords, classifyChat } from './horseChatIntent.js';

describe('classifyChat reads what players really typed', () => {
  it.each([
    ['Nice Hand', 'reply_thanks'],
    ['Well Played', 'reply_thanks'],
    ['NICE BALUE BET CAPTAIN', 'reply_thanks'],
    ['nh', 'reply_thanks'],
    ['gg wp', 'reply_thanks'],
    ['Unlucky', 'reply_sympathy'],
    ['unlucky, sorry man', 'reply_sympathy'],
    ['brutal beat', 'reply_sympathy'],
    ['Lucky', 'reply_ribbed'],
    ['FUCKING LUCK BOX', 'reply_ribbed'],
    ['you got lucky', 'reply_ribbed'],
    ['how did you call that', 'reply_ribbed'],
    ['Got lucky', 'reply_humble'],
    ['Misclick', 'reply_humble'],
    ['FAT FINGERED THAT SMH', 'reply_humble'],
    ['my bad', 'reply_humble'],
    ['Hey Ingrid', 'reply_hello'],
    ['Just got on here', 'reply_hello'],
    ['Good Luck', 'reply_hello'],
    ['gl all', 'reply_hello'],
    ['YOU GUYS PLAY HERE EVERY NIGHT?! LOL', 'reply_regular'],
    ['do you play here a lot', 'reply_regular'],
  ])('"%s" is %s', (line, intent) => {
    expect(classifyChat(line)).toBe(intent);
  });

  it('"unlucky" is never read as "lucky"', () => {
    expect(classifyChat('unlucky')).toBe('reply_sympathy');
    expect(classifyChat('so unlucky')).toBe('reply_sympathy');
  });

  it.each([
    'Is this glitchy to anyone else ?',
    'Not sure it’s physically possible to bet as fast as he did',
    'im not getting texts... so call me if you need me',
    'Costa!!!',
    'How do I know if a table is doing bomb pots?',
    '',
    '   ',
  ])('"%s" is not a remark a horse answers', (line) => {
    expect(classifyChat(line)).toBeNull();
  });
});

describe('a horse never answers whether anyone is real, a bot or the game is fair', () => {
  // A horse does not claim to be a person and does not argue about integrity.
  it.each([
    'Trey, you real?',
    'are you a bot',
    'nh, you a bot?',
    'is everyone here a robot lol',
    'these are all AI',
    'any humans here?',
    'this site is rigged',
    'nice hand cheater',
    'you guys colluding?',
    'feels scripted',
    'hey are you a real person',
  ])('"%s" gets no reply', (line) => {
    expect(classifyChat(line)).toBeNull();
  });

  it('the refusal wins over a greeting or a compliment in the same line', () => {
    expect(classifyChat('hey bot')).toBeNull();
    expect(classifyChat('nice hand, rigged though')).toBeNull();
  });
});

describe('the words are read the way chat is typed', () => {
  it('folds shorthand, case, apostrophes and punctuation', () => {
    expect(chatWords("NH!!! Can't believe it")).toBe('nice hand cant believe it');
    expect(chatWords('wp u got me')).toBe('well played you got me');
  });
  it('the same text always reads the same', () => {
    for (let i = 0; i < 3; i++) expect(classifyChat('Nice Hand')).toBe('reply_thanks');
  });
});

describe('addressedHorse finds the one seated horse a line names', () => {
  const horses = [
    { userId: 'h1', username: 'Ingrid' },
    { userId: 'h2', username: 'Trey' },
    { userId: 'h3', username: 'yo' },
  ];
  it('a name, any case, as a whole word', () => {
    expect(addressedHorse('Hey Ingrid', horses)).toBe('h1');
    expect(addressedHorse('nh trey!', horses)).toBe('h2');
  });
  it('a name inside another word is not an address', () => {
    expect(addressedHorse('treyvon says hi', horses)).toBeNull();
  });
  it('two names is no single address; a two-letter name is too common to count', () => {
    expect(addressedHorse('ingrid and trey, gg', horses)).toBeNull();
    expect(addressedHorse('yo whats up', horses)).toBeNull();
  });
  it('no name, no address', () => {
    expect(addressedHorse('nice hand', horses)).toBeNull();
    expect(addressedHorse('hello', [{ userId: 'h4', username: null }])).toBeNull();
  });
});
