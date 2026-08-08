import { describe, expect, it } from 'vitest';
import type { Hex, Tag } from '../types.js';
import {
  eTags,
  formatAddress,
  intTagValue,
  isHex64,
  parseAddress,
  pubkeys,
  referencedEventId,
  rootEventId,
  tagRest,
  tagValue,
  tagValues,
  tagsNamed,
} from './tags.js';

const A = 'a'.repeat(64) as Hex;
const B = 'b'.repeat(64) as Hex;
const C = 'c'.repeat(64) as Hex;

describe('isHex64', () => {
  it.each([
    [A, true],
    ['A'.repeat(64), false], // uppercase — NIP-GM requires lowercase
    ['a'.repeat(63), false],
    ['a'.repeat(65), false],
    ['g'.repeat(64), false],
    ['', false],
    [undefined, false],
    [42, false],
  ])('%s -> %s', (value, expected) => {
    expect(isHex64(value)).toBe(expected);
  });
});

describe('tag accessors', () => {
  const tags: Tag[] = [
    ['d', 'lobby-1'],
    ['p', A, '', 'ready'],
    ['p', B, '', 'joined'],
    ['relays', 'wss://one', 'wss://two'],
    ['seq', '13'],
  ];

  it('reads first values and all values', () => {
    expect(tagValue(tags, 'd')).toBe('lobby-1');
    expect(tagValue(tags, 'missing')).toBeUndefined();
    expect(tagValues(tags, 'p')).toEqual([A, B]);
    expect(tagsNamed(tags, 'p')).toHaveLength(2);
  });

  it('reads the rest of a multi-value tag', () => {
    expect(tagRest(tags, 'relays')).toEqual(['wss://one', 'wss://two']);
    expect(tagRest(tags, 'missing')).toEqual([]);
  });

  it('preserves p-tag order, because that is seat order', () => {
    const reversed: Tag[] = [['p', C], ['p', A], ['p', B]];
    expect(pubkeys(reversed)).toEqual([C, A, B]);
  });

  it('drops malformed pubkeys rather than passing them through', () => {
    expect(pubkeys([['p', A], ['p', 'nope'], ['p', B]])).toEqual([A, B]);
  });

  it('parses integer tags strictly', () => {
    expect(intTagValue(tags, 'seq')).toBe(13);
    expect(intTagValue([['seq', '1e3']], 'seq')).toBeUndefined();
    expect(intTagValue([['seq', ' 12 ']], 'seq')).toBeUndefined();
    expect(intTagValue([['seq', '0x0c']], 'seq')).toBeUndefined();
    expect(intTagValue([['seq', '-1']], 'seq')).toBeUndefined();
    expect(intTagValue([['seq', '007']], 'seq')).toBe(7);
  });
});

describe('e tags', () => {
  const tags: Tag[] = [
    ['e', A],
    ['e', B, 'wss://relay', 'root'],
  ];

  it('separates the referenced event from the game root', () => {
    expect(referencedEventId(tags)).toBe(A);
    expect(rootEventId(tags)).toBe(B);
  });

  it('exposes relay hints', () => {
    expect(eTags(tags)).toEqual([
      { id: A, relay: undefined, marker: undefined },
      { id: B, relay: 'wss://relay', marker: 'root' },
    ]);
  });

  it('ignores e tags with malformed ids', () => {
    expect(eTags([['e', 'short']])).toEqual([]);
  });
});

describe('addresses', () => {
  it('round-trips', () => {
    const pointer = { kind: 32601, pubkey: A, identifier: 'friday-poker' };
    expect(parseAddress(formatAddress(pointer))).toEqual(pointer);
  });

  it('keeps colons inside the identifier', () => {
    // `d` values are free-form; splitting on every colon would corrupt them.
    const pointer = { kind: 32600, pubkey: A, identifier: 'com.example:holdem:v2' };
    expect(parseAddress(formatAddress(pointer))).toEqual(pointer);
  });

  it('allows an empty identifier', () => {
    expect(parseAddress(`32601:${A}:`)).toEqual({ kind: 32601, pubkey: A, identifier: '' });
  });

  it.each([
    ['no colons', 'nonsense'],
    ['one colon', `32601:${A}`],
    ['bad pubkey', '32601:nope:x'],
    ['bad kind', `abc:${A}:x`],
    ['empty', ''],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(parseAddress(value as string)).toBeUndefined();
  });
});
