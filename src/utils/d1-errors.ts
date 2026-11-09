export type D1TransientErrorCode =
  | 'D1_OVERLOADED'
  | 'D1_TIMEOUT'
  | 'D1_LOCKED'
  | 'D1_NETWORK'
  | 'D1_UNAVAILABLE'
  | 'D1_OBJECT_RESET'
  | 'D1_STORAGE';

interface ErrorPattern {
  code: D1TransientErrorCode;
  pattern: RegExp;
  retryAfterSeconds: number;
}

// Keep these patterns aligned with the errors Cloudflare D1 and local
// wrangler dev actually surface. They intentionally describe retryable
// infrastructure failures only; permanent SQL errors (syntax, constraints,
// missing tables) must keep falling through to the generic 500 path.
const TRANSIENT_ERROR_PATTERNS: ErrorPattern[] = [
  {
    code: 'D1_OVERLOADED',
    pattern: /\boverload(?:ed)?\b|too many concurrent|queue (?:is )?full|d1[^\n]*\bbusy\b/i,
    retryAfterSeconds: 2,
  },
  {
    code: 'D1_TIMEOUT',
    pattern: /\btimed?\s*out\b|\btimeout\b|exceeded (?:the )?(?:execution )?time|storage operation exceeded/i,
    retryAfterSeconds: 3,
  },
  {
    code: 'D1_LOCKED',
    pattern: /sqlite_busy|sqlite_locked|database is locked|database table is locked/i,
    retryAfterSeconds: 1,
  },
  {
    code: 'D1_NETWORK',
    pattern:
      /network (?:connection )?(?:error|lost|unavailable|interrupted)|connection .*(?:lost|reset|closed|refused|interrupted)|econnreset|econnrefused|etimedout|enotfound|eai_again|fetch failed|failed to fetch|socket hang up|connection error/i,
    retryAfterSeconds: 1,
  },
  {
    code: 'D1_OBJECT_RESET',
    pattern:
      /durable object (?:was )?(?:reset|restarted)|object was reset|reset because (?:its )?(?:code|storage)|storage (?:was )?reset|d1.*reset/i,
    retryAfterSeconds: 1,
  },
  {
    code: 'D1_UNAVAILABLE',
    pattern:
      /could not (?:resolve|find|connect to) (?:the )?d1|d1.*(?:unavailable|not available|temporarily unavailable|failed to (?:connect|open))|database.*temporarily unavailable|d1 database.*(?:unavailable|error)/i,
    retryAfterSeconds: 5,
  },
  {
    code: 'D1_STORAGE',
    pattern: /storage operation (?:failed|error|exceeded)|d1 storage|internal error in (?:the )?d1 database|d1_error: internal error/i,
    retryAfterSeconds: 2,
  },
];

function collectErrorText(value: unknown, parts: string[], depth: number, seen: Set<unknown>): void {
  if (value == null || depth > 6 || seen.has(value)) return;
  if (typeof value === 'string') {
    parts.push(value);
    return;
  }
  if (typeof value !== 'object') {
    if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
    return;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ['name', 'message', 'code', 'error', 'reason', 'details', 'cause', 'stack']) {
    const next = record[key];
    if (typeof next === 'string') {
      parts.push(next);
    } else if (next && typeof next === 'object') {
      collectErrorText(next, parts, depth + 1, seen);
    }
  }
}

export function getD1ErrorText(error: unknown): string {
  const parts: string[] = [];
  collectErrorText(error, parts, 0, new Set<unknown>());
  return parts.join('\n');
}

export function getD1ErrorCode(error: unknown): D1TransientErrorCode | null {
  const text = getD1ErrorText(error);
  if (!text.trim()) return null;
  for (const entry of TRANSIENT_ERROR_PATTERNS) {
    if (entry.pattern.test(text)) return entry.code;
  }
  return null;
}

export function isD1TransientError(error: unknown): boolean {
  return getD1ErrorCode(error) !== null;
}

export function getD1RetryAfterSeconds(error: unknown): number {
  const code = getD1ErrorCode(error);
  if (!code) return 5;
  return TRANSIENT_ERROR_PATTERNS.find((entry) => entry.code === code)?.retryAfterSeconds ?? 5;
}

export function getErrorLogMessage(error: unknown): string {
  const text = getD1ErrorText(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}
