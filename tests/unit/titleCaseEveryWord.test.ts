import { describe, expect, it } from 'vitest';
import { enumToTitleCase, titleCase } from '../../src/utils/titleCase';

describe('Club Arena Every-Word Capitalization Law', () => {
  it('capitalizes joining words instead of applying conventional minor-word exceptions', () => {
    expect(titleCase('create a club and invite a player')).toBe(
      'Create A Club And Invite A Player'
    );
    expect(titleCase('request to join the club')).toBe('Request To Join The Club');
  });

  it('keeps platform acronyms uppercase while capitalizing every surrounding word', () => {
    expect(titleCase('watch an nlh table or a plo5 tournament')).toBe(
      'Watch An NLH Table Or A PLO5 Tournament'
    );
    expect(enumToTitleCase('request_to_join')).toBe('Request To Join');
  });
});
