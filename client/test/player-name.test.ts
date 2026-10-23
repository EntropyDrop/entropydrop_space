import test from 'node:test';
import assert from 'node:assert/strict';
import { rememberSpacePlayerName, readCachedSpacePlayerName } from '../src/bootstrap/SpacePlayerName.ts';

const token = (sub: string) => `header.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.signature`;
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

test('tutorial display names follow the current account across token refresh and logout', () => {
  const saved = storage();
  saved.setItem('token', token('alice'));
  rememberSpacePlayerName({ user_id: 'alice', username: 'Alice <Engineer>' }, token('alice'), saved);
  assert.equal(readCachedSpacePlayerName(saved), 'Alice <Engineer>');
  saved.setItem('token', `${token('alice')}-refreshed`);
  assert.equal(readCachedSpacePlayerName(saved), 'Alice <Engineer>');
  saved.setItem('token', token('bob'));
  assert.equal(readCachedSpacePlayerName(saved), null, 'do not show another account’s cached name');
  rememberSpacePlayerName({ user_id: 'bob', username: 'Bob' }, token('bob'), saved);
  assert.equal(readCachedSpacePlayerName(saved), 'Bob');
  saved.removeItem('token');
  assert.equal(readCachedSpacePlayerName(saved), null);
});

test('missing names, malformed data and unavailable storage leave a safe local fallback', () => {
  const saved = storage();
  saved.setItem('token', token('alice'));
  rememberSpacePlayerName({ user_id: 'bob', username: 'Wrong account' }, token('alice'), saved);
  assert.equal(readCachedSpacePlayerName(saved), null);
  rememberSpacePlayerName({ user_id: 'alice', username: 'Alice' }, token('alice'), saved);
  rememberSpacePlayerName({ user_id: 'alice', username: null }, token('alice'), saved);
  assert.equal(readCachedSpacePlayerName(saved), null);
  saved.setItem('space.player-name.v1', '{');
  assert.equal(readCachedSpacePlayerName(saved), null);
  saved.setItem('token', 'not-a-token');
  assert.equal(readCachedSpacePlayerName(saved), null);
  const unavailable = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  assert.doesNotThrow(() => rememberSpacePlayerName({ user_id: 'alice', username: 'Alice' }, token('alice'), unavailable));
  assert.equal(readCachedSpacePlayerName(unavailable), null);
});
