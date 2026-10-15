// Flight Finder: a tiny web server that serves the site in ./public and
// forwards searches to SerpAPI so the API key never reaches the browser.
//
//   SERPAPI_API_KEY=... node server.js
//
// No npm dependencies; needs Node 20 or newer.

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { createCache } from './lib/cache.js';
import {
  HttpError,
  CURRENCIES,
  MAX_WINDOW_DAYS,
  exploreRequest,
  mapLimit,
  normalizeDestinations,
  normalizeFlights,
  parseSearch,
  routeRequests,
  serpSearch,
  todayIso,
} from './lib/flights.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');

loadDotEnv(path.join(ROOT, '.env'));

const config = {
  apiKey: process.env.SERPAPI_API_KEY,
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 3000,
  locale: { gl: process.env.SERPAPI_GL || 'nl', hl: process.env.SERPAPI_HL || 'en' },
  defaultCurrency: CURRENCIES.includes(process.env.DEFAULT_CURRENCY) ? process.env.DEFAULT_CURRENCY : 'EUR',
  cacheHours: Number(process.env.CACHE_HOURS ?? 3),
  dailySearchLimit: Number(process.env.DAILY_SEARCH_LIMIT ?? 50),
  basicAuth: process.env.BASIC_AUTH || '',
};

if (!config.apiKey) {
  console.error('SERPAPI_API_KEY is not set. Put it in sites/flight-finder/.env or the environment.');
  process.exit(1);
}

const cache = createCache({ dir: path.join(ROOT, '.cache'), ttlMs: config.cacheHours * 3600 * 1000 });
const takeFromDailyBudget = createDailyBudget(config.dailySearchLimit);
let quotaCache = { at: 0, value: undefined };
const searchOptions = {
  apiKey: config.apiKey,
  cache,
  beforeLiveSearch() {
    takeFromDailyBudget();
    quotaCache.at = 0; // the remaining-search count is about to change
  },
};

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

/** Caps live (uncached) SerpAPI searches per UTC day, so a busy day cannot drain the monthly plan. */
function createDailyBudget(limit) {
  let day = '';
  let used = 0;
  return () => {
    if (!limit) return;
    const today = todayIso();
    if (today !== day) {
      day = today;
      used = 0;
    }
    if (used >= limit) {
      throw new HttpError(
        429,
        `Daily limit of ${limit} live searches reached. Raise DAILY_SEARCH_LIMIT to allow more.`,
      );
    }
    used++;
  };
}

function searchContext() {
  return { today: todayIso(), defaultCurrency: config.defaultCurrency };
}

async function handleExplore(query) {
  const q = parseSearch(query, 'explore', searchContext());
  const params = exploreRequest(q, config.locale);
  const { data, cached } = await serpSearch(params, searchOptions);
  return {
    query: q,
    source: params.engine,
    searchesUsed: cached ? 0 : 1,
    destinations: normalizeDestinations(params.engine, data, q),
  };
}

async function handleRoute(query) {
  const q = parseSearch(query, 'route', searchContext());
  const requests = routeRequests(q, config.locale);

  const days = await mapLimit(requests, 3, async (params) => {
    const day = { date: params.outbound_date, returnDate: params.return_date };
    try {
      const { data, cached } = await serpSearch(params, searchOptions);
      return { ...day, cached, ...normalizeFlights(data) };
    } catch (err) {
      // One failed day should not hide the others; a bad key or empty quota fails them all anyway.
      return { ...day, cached: false, error: err.message, status: err.status, flights: [] };
    }
  });

  const failed = days.filter((d) => d.error);
  if (failed.length === days.length) throw new HttpError(failed[0].status || 502, failed[0].error);

  return {
    query: q,
    searchesUsed: days.filter((d) => !d.cached && !d.error).length,
    days: days.map(({ status, ...day }) => day),
  };
}

async function handleQuota() {
  if (Date.now() - quotaCache.at < 30000) return quotaCache.value;
  const url = new URL('https://serpapi.com/account.json');
  url.searchParams.set('api_key', config.apiKey);
  let data;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    data = await res.json();
  } catch {
    throw new HttpError(502, 'Could not reach SerpAPI to check the remaining searches.');
  }
  if (data.error) throw new HttpError(502, `SerpAPI: ${data.error}`);
  const value = {
    plan: data.plan_name,
    searchesLeft: data.total_searches_left,
    searchesPerMonth: data.searches_per_month,
    usedThisMonth: data.this_month_usage,
  };
  quotaCache = { at: Date.now(), value };
  return value;
}

const API_ROUTES = {
  '/api/explore': handleExplore,
  '/api/route': handleRoute,
  '/api/quota': handleQuota,
  '/api/config': async () => ({
    currencies: CURRENCIES,
    defaultCurrency: config.defaultCurrency,
    maxWindowDays: MAX_WINDOW_DAYS,
  }),
};

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://*.gstatic.com; style-src 'self'; script-src 'self'; " +
    "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function send(req, res, status, body, headers = {}) {
  let payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const type = headers['Content-Type'] || '';
  const compressible = /^(text\/|application\/json|image\/svg)/.test(type) && payload.length > 1024;
  if (compressible && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    payload = gzipSync(payload);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Length': payload.length, Vary: 'Accept-Encoding' });
  res.end(req.method === 'HEAD' ? undefined : payload);
}

function sendJson(req, res, status, value) {
  send(req, res, status, JSON.stringify(value), {
    'Content-Type': CONTENT_TYPES['.json'],
    'Cache-Control': 'no-store',
  });
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, relative);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(req, res, 404, { error: 'Not found' });

  let body;
  try {
    body = await readFile(file);
  } catch {
    return send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const ext = path.extname(file);
  send(req, res, 200, body, {
    'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
  });
}

const sha256 = (value) => createHash('sha256').update(value).digest();

function isAuthorized(req) {
  if (!config.basicAuth) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6), 'base64').toString();
  return timingSafeEqual(sha256(given), sha256(config.basicAuth));
}

const server = http.createServer(async (req, res) => {
  if (!isAuthorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Flight Finder"', 'Content-Type': 'text/plain' });
    return res.end('Login required');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(req, res, 405, { error: 'Method not allowed' });
  }

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return sendJson(req, res, 400, { error: 'Bad request' });
  }

  const handler = API_ROUTES[url.pathname];
  if (!handler) {
    if (url.pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'Unknown API endpoint' });
    return serveStatic(req, res, url.pathname).catch(() => sendJson(req, res, 400, { error: 'Bad request' }));
  }

  try {
    sendJson(req, res, 200, await handler(url.searchParams));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(req, res, status, { error: err instanceof HttpError ? err.message : 'Something went wrong.' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    `Flight Finder running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
  );
});
