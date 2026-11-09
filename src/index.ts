import { Env } from './types';
import { NotificationsHub } from './durable/notifications-hub';
import { BackupTransferRunner } from './durable/backup-transfer-runner';
import { handleRequest } from './router';
import { StorageService } from './services/storage';
import { applyCors, jsonResponse } from './utils/response';
import { getD1ErrorCode, getD1RetryAfterSeconds } from './utils/d1-errors';
import { runScheduledBackupIfDue } from './handlers/backup';
import {
  isBackendRequestPath,
  isWebVaultHidden,
  webVaultNotFoundResponse,
} from './web-vault-visibility';

let dbInitialized = false;
let dbInitError: string | null = null;
let dbInitPromise: Promise<void> | null = null;

function normalizeRequestUrl(request: Request): Request {
  const url = new URL(request.url);
  const normalizedPathname = url.pathname.length <= 1 ? url.pathname : url.pathname.replace(/\/+$/, '');
  if (normalizedPathname === url.pathname) return request;

  url.pathname = normalizedPathname;
  return new Request(url.toString(), request);
}

function addSearchIndexHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const contentType = String(response.headers.get('Content-Type') || '').toLowerCase();
  const shouldNoIndex =
    url.pathname === '/robots.txt' ||
    contentType.includes('text/html');

  if (!shouldNoIndex) return response;

  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function maybeServeAsset(request: Request, env: Env): Promise<Response | null> {
  if (!env.ASSETS) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (isBackendRequestPath(url.pathname)) return null;

  const response = await env.ASSETS.fetch(request);
  return addSearchIndexHeaders(request, response);
}

async function ensureDatabaseInitialized(env: Env): Promise<void> {
  if (dbInitialized) return;

  if (!dbInitPromise) {
    dbInitPromise = (async () => {
      const storage = new StorageService(env.DB);
      await storage.initializeDatabase();
      dbInitialized = true;
      dbInitError = null;
    })()
      .catch((error: unknown) => {
        console.error('Failed to initialize database:', error);
        dbInitError = error instanceof Error ? error.message : 'Unknown database initialization error';
      })
      .finally(() => {
        dbInitPromise = null;
      });
  }

  await dbInitPromise;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const normalizedRequest = normalizeRequestUrl(request);
    const requestPath = new URL(normalizedRequest.url).pathname;

    if (isWebVaultHidden(env) && !isBackendRequestPath(requestPath)) {
      return webVaultNotFoundResponse(normalizedRequest);
    }

    const assetResponse = await maybeServeAsset(normalizedRequest, env);
    if (assetResponse) {
      return applyCors(normalizedRequest, assetResponse, env);
    }

    await ensureDatabaseInitialized(env);
    if (dbInitError) {
      // Log full error server-side, return generic message to client.
      console.error('DB init error (not forwarded to client):', dbInitError);
      // D1-401: an overloaded/unavailable database during bootstrap is a
      // transient outage, not a permanent application failure.
      const d1ErrorCode = getD1ErrorCode(dbInitError);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (d1ErrorCode) headers['Retry-After'] = String(getD1RetryAfterSeconds(dbInitError));
      const resp = jsonResponse(
        {
          error: d1ErrorCode ? 'Service temporarily unavailable' : 'Database not initialized',
          error_description: d1ErrorCode
            ? 'Service temporarily unavailable'
            : 'Database initialization failed. Check server logs for details.',
          ...(d1ErrorCode ? { code: d1ErrorCode } : {}),
          ErrorModel: {
            Message: 'Service temporarily unavailable',
            Object: 'error',
            ...(d1ErrorCode ? { Code: d1ErrorCode } : {}),
          },
        },
        d1ErrorCode ? 503 : 500,
        headers
      );
      return applyCors(normalizedRequest, resp, env);
    }

    const resp = await handleRequest(normalizedRequest, env);
    return applyCors(normalizedRequest, resp, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    void controller;
    await ensureDatabaseInitialized(env);
    if (dbInitError) {
      console.error('Skipping scheduled backup because DB init failed:', dbInitError);
      return;
    }
    ctx.waitUntil(runScheduledBackupIfDue(env).catch((error) => {
      console.error('Scheduled backup failed:', error);
    }));
  },
};

export { NotificationsHub };
export { BackupTransferRunner };
