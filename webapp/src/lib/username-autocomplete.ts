import type { Cipher } from './types';

function isDeleted(cipher: Cipher): boolean {
  return !!(cipher.deletedDate || (cipher as { deletedAt?: string | null }).deletedAt);
}

function isArchived(cipher: Cipher): boolean {
  return !!(cipher.archivedDate || (cipher as { archivedAt?: string | null }).archivedAt);
}

function loginUsername(cipher: Cipher): string {
  return String(cipher.login?.decUsername ?? cipher.login?.username ?? '').trim();
}

export function buildLoginUsernameIndex(ciphers: readonly Cipher[]): string[] {
  const seen = new Set<string>();
  const usernames: string[] = [];
  for (const cipher of ciphers) {
    if (Number(cipher.type || 0) !== 1) continue;
    if (isDeleted(cipher) || isArchived(cipher)) continue;
    const username = loginUsername(cipher);
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    usernames.push(username);
  }
  return usernames;
}

export function findUsernameCompletion(value: string, usernames: readonly string[]): string | null {
  const typed = String(value || '');
  if (!typed.trim()) return null;
  const lower = typed.toLowerCase();
  for (const username of usernames) {
    if (username.length > typed.length && username.toLowerCase().startsWith(lower)) {
      return username;
    }
  }
  return null;
}
