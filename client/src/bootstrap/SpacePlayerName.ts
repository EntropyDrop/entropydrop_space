type NameStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const PLAYER_NAME_KEY = 'space.player-name.v1';

// The subject only scopes a display-name cache. It never grants account access.
function tokenSubject(token: string | null): string | null {
  if (!token) return null;
  const segment = token.split('.')[1]?.replace(/-/g, '+').replace(/_/g, '/');
  if (!segment) return null;
  const payload = JSON.parse(atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
  return typeof payload?.sub === 'string' ? payload.sub : null;
}

/** Share the online player's name with a tutorial tab without requesting a profile. */
export function rememberSpacePlayerName(player: { user_id: string; username: string | null }, token: string, storage?: NameStorage): void {
  try {
    const target = storage ?? globalThis.localStorage;
    if (tokenSubject(token) !== player.user_id) return;
    const username = player.username?.trim();
    if (username) target.setItem(PLAYER_NAME_KEY, JSON.stringify({ userId: player.user_id, username }));
    else target.removeItem(PLAYER_NAME_KEY);
  } catch { /* Storage restrictions must not prevent entering a world. */ }
}

export function readCachedSpacePlayerName(storage?: NameStorage): string | null {
  try {
    const target = storage ?? globalThis.localStorage;
    const userId = tokenSubject(target.getItem('token'));
    if (!userId) return null;
    const cached = JSON.parse(target.getItem(PLAYER_NAME_KEY) || 'null');
    return cached?.userId === userId && typeof cached.username === 'string'
      ? cached.username.trim() || null : null;
  } catch { return null; }
}
