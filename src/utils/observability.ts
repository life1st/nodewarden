import type { Env } from '../types';

export interface D1CallRecord {
  op: 'run' | 'all' | 'first' | 'raw' | 'batch' | 'exec';
  sql: string;
  durationMs: number;
}

export interface RequestObservabilityContext {
  requestId: string;
  operation: string;
  method: string;
  path: string;
  userId: string | null;
  startedAt: number;
  retries: number;
  d1Calls: number;
  d1DurationMs: number;
  d1CallDetails: D1CallRecord[];
}

const RAW_D1_STATEMENT = Symbol('rawD1Statement');
const MAX_LOGGED_D1_STEPS = 40;
const SLOW_REQUEST_THRESHOLD_MS = 1000;

function randomRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getOperationName(method: string, path: string): string {
  const upperMethod = String(method || 'GET').toUpperCase();
  const verb = upperMethod.toLowerCase();

  if (path === '/api/sync') return 'vault.sync';
  if (path === '/api/ciphers/import') return 'cipher.import';
  if (path === '/api/ciphers/delete-permanent') return 'cipher.deletePermanentBulk';
  if (path === '/api/ciphers/delete') return 'cipher.deleteBulk';
  if (path === '/api/ciphers/restore') return 'cipher.restoreBulk';
  if (path === '/api/ciphers/archive') return 'cipher.archiveBulk';
  if (path === '/api/ciphers/unarchive') return 'cipher.unarchiveBulk';
  if (path === '/api/ciphers/move') return 'cipher.moveBulk';
  if (path === '/api/ciphers' || path === '/api/ciphers/create') {
    if (verb === 'post') return 'cipher.create';
    if (verb === 'delete') return 'cipher.deletePermanentBulk';
    return 'cipher.list';
  }

  const cipherMatch = path.match(/^\/api\/ciphers\/([^/]+)(\/.*)?$/i);
  if (cipherMatch) {
    const subPath = cipherMatch[2] || '';
    if (/^\/attachment(?:\/|$)/i.test(subPath)) return `attachment.${verb}`;
    if (subPath === '/archive') return 'cipher.archive';
    if (subPath === '/unarchive') return 'cipher.unarchive';
    if (subPath === '/restore') return 'cipher.restore';
    if (subPath === '/partial') return 'cipher.partialUpdate';
    if (subPath === '/delete') return verb === 'delete' || verb === 'post' ? 'cipher.deletePermanent' : 'cipher.delete';
    if (subPath === '' || subPath === '/') {
      if (verb === 'put' || verb === 'post') return 'cipher.update';
      if (verb === 'delete') return 'cipher.delete';
      return 'cipher.get';
    }
    return `cipher.${verb}`;
  }

  if (path === '/api/folders') {
    if (verb === 'post') return 'folder.create';
    return 'folder.list';
  }
  if (path === '/api/folders/delete') return 'folder.deleteBulk';
  const folderMatch = path.match(/^\/api\/folders\/([^/]+)$/i);
  if (folderMatch) {
    if (verb === 'put') return 'folder.update';
    if (verb === 'delete') return 'folder.delete';
    return 'folder.get';
  }

  if (path === '/api/sends') {
    if (verb === 'post') return 'send.create';
    return 'send.list';
  }
  if (path === '/api/sends/delete') return 'send.deleteBulk';
  if (/^\/api\/sends\//i.test(path)) return `send.${verb}`;

  if (path.startsWith('/api/accounts/')) return `account.${verb}`;
  if (path.startsWith('/api/devices')) return `device.${verb}`;
  if (path.startsWith('/api/webauthn')) return `webauthn.${verb}`;
  if (path.startsWith('/api/two-factor')) return `twoFactor.${verb}`;
  if (path.startsWith('/api/admin/')) return `admin.${verb}`;
  if (path.startsWith('/api/')) return `api.${verb}`;
  return `${verb} ${path}`;
}

export function createRequestObservabilityContext(request: Request): RequestObservabilityContext {
  const url = new URL(request.url);
  const retryHeader = Number(request.headers.get('X-NodeWarden-Retry') || 0);
  return {
    requestId: randomRequestId(),
    operation: getOperationName(request.method, url.pathname),
    method: request.method,
    path: url.pathname,
    userId: null,
    startedAt: Date.now(),
    retries: Number.isFinite(retryHeader) && retryHeader > 0 ? Math.floor(retryHeader) : 0,
    d1Calls: 0,
    d1DurationMs: 0,
    d1CallDetails: [],
  };
}

function summarizeSql(sql: string): string {
  return String(sql || '')
    .replace(/'(?:''|[^'])*'/g, "'?'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function recordD1Call(
  ctx: RequestObservabilityContext,
  op: D1CallRecord['op'],
  sql: string,
  durationMs: number
): void {
  ctx.d1Calls += 1;
  ctx.d1DurationMs += durationMs;
  if (ctx.d1CallDetails.length < MAX_LOGGED_D1_STEPS) {
    ctx.d1CallDetails.push({
      op,
      sql: summarizeSql(sql),
      durationMs: Math.max(0, Math.round(durationMs * 1000) / 1000),
    });
  }
}

async function measureD1Call<T>(
  ctx: RequestObservabilityContext,
  op: D1CallRecord['op'],
  sql: string,
  run: () => Promise<T>
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await run();
  } finally {
    recordD1Call(ctx, op, sql, Date.now() - startedAt);
  }
}

function wrapD1Statement(
  statement: D1PreparedStatement,
  ctx: RequestObservabilityContext,
  sql: string
): D1PreparedStatement {
  const wrapped = {
    [RAW_D1_STATEMENT]: statement,
    bind(...values: unknown[]) {
      return wrapD1Statement(statement.bind(...values), ctx, sql);
    },
    run() {
      return measureD1Call(ctx, 'run', sql, () => statement.run());
    },
    all() {
      return measureD1Call(ctx, 'all', sql, () => statement.all());
    },
    first(...args: unknown[]) {
      return measureD1Call(ctx, 'first', sql, () => (statement.first as any)(...args));
    },
    raw(...args: unknown[]) {
      return measureD1Call(ctx, 'raw', sql, () => (statement.raw as any)(...args));
    },
  };
  return wrapped as unknown as D1PreparedStatement;
}

function unwrapD1Statement(statement: D1PreparedStatement): D1PreparedStatement {
  return ((statement as any)?.[RAW_D1_STATEMENT] as D1PreparedStatement | undefined) ?? statement;
}

export function wrapD1Database(db: D1Database, ctx: RequestObservabilityContext): D1Database {
  const wrapped: any = {
    prepare(query: string) {
      return wrapD1Statement(db.prepare(query), ctx, query);
    },
    batch(statements: D1PreparedStatement[]) {
      const rawStatements = statements.map(unwrapD1Statement);
      return measureD1Call(ctx, 'batch', `batch(${rawStatements.length})`, () => db.batch(rawStatements));
    },
    exec(query: string) {
      return measureD1Call(ctx, 'exec', query, () => db.exec(query));
    },
    dump() {
      return db.dump();
    },
    withSession(constraint?: unknown) {
      const session = (db as any).withSession?.(constraint);
      return session ? wrapD1Database(session, ctx) : wrapped;
    },
  };
  return wrapped as D1Database;
}

export function createObservedEnv(env: Env, ctx: RequestObservabilityContext): Env {
  const observedDb = wrapD1Database(env.DB, ctx);
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === 'DB') return observedDb;
      return Reflect.get(target, property, receiver);
    },
  });
}

export function markRequestUser(ctx: RequestObservabilityContext, userId: string | null | undefined): void {
  ctx.userId = userId ? String(userId) : null;
}

function inferErrorCode(status: number): string | null {
  if (status === 409) return 'VERSION_CONFLICT';
  if (status === 503) return 'SERVICE_UNAVAILABLE';
  if (status >= 500) return 'INTERNAL_ERROR';
  return null;
}

export function logRequestSummary(
  ctx: RequestObservabilityContext,
  status: number,
  errorCode?: string | null
): void {
  const durationMs = Date.now() - ctx.startedAt;
  const payload: Record<string, unknown> = {
    requestId: ctx.requestId,
    operation: ctx.operation,
    userId: ctx.userId,
    method: ctx.method,
    path: ctx.path,
    durationMs,
    d1Calls: ctx.d1Calls,
    d1DurationMs: Math.round(ctx.d1DurationMs * 1000) / 1000,
    status,
    errorCode: errorCode ?? (status >= 400 ? inferErrorCode(status) : null),
    retries: ctx.retries,
  };

  if (ctx.d1CallDetails.length) {
    payload.d1Steps = ctx.d1CallDetails;
    if (ctx.d1Calls > ctx.d1CallDetails.length) payload.d1StepsTruncated = true;
  }
  if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
    payload.slow = true;
  }

  const line = JSON.stringify(payload);
  if (status >= 500) console.error(line);
  else console.log(line);
}

export function withRequestId(response: Response, requestId: string): Response {
  const webSocket = (response as Response & { webSocket?: unknown }).webSocket;
  if (response.status === 101 || webSocket) return response;

  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
