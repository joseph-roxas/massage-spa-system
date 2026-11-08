import { describe, expect, it } from 'vitest';
import { properName } from './staff';

describe('properName', () => {
  it.each([
    ['MARIA', 'Maria'],
    ['maria', 'Maria'],
    ['mArIa', 'Maria'],
    ['  dela   CRUZ ', 'Dela Cruz'],
    ['ma. luisa', 'Ma. Luisa'],
    ['santos-reyes', 'Santos-Reyes'],
    ["o'neil", "O'Neil"],
    ['PEÑARANDA', 'Peñaranda'],
    ['ñino', 'Ñino'],
    ['reyes iii', 'Reyes III'],
    ['Reyes jr.', 'Reyes Jr.'],
  ])('%s becomes %s', (typed, kept) => {
    expect(properName(typed)).toBe(kept);
  });

  it('keeps a name that only looks like a suffix when it comes first', () => {
    expect(properName('VI')).toBe('Vi');
  });
});
