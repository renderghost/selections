// One-time sign-in with your TIDAL account, for when TIDAL won't let the app
// read your playlists with client credentials alone.
//
//   npm run tidal:login            prints TIDAL_REFRESH_TOKEN and TIDAL_USER_ID
//   npm run tidal:login -- --save  also writes them into .env
//
// Uses the OAuth 2.1 authorisation-code flow with PKCE. Register the redirect
// URI (default http://localhost:3000/callback) in your app at
// developer.tidal.com first, and stop the app if it is using that port.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadEnvFile } from '../src/config.js';

const AUTHORIZE_URL = 'https://login.tidal.com/authorize';
const TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const API_URL = 'https://openapi.tidal.com/v2';
const TIMEOUT_MS = 5 * 60_000;

loadEnvFile();
const clientId = process.env.TIDAL_CLIENT_ID?.trim();
const clientSecret = process.env.TIDAL_CLIENT_SECRET?.trim();
const redirectUri = process.env.TIDAL_REDIRECT_URI?.trim() || 'http://localhost:3000/callback';
const scopes = process.env.TIDAL_SCOPES?.trim() || 'user.read playlists.read';
const save = process.argv.includes('--save');

const fail = (message) => {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
};

if (!clientId) fail('Set TIDAL_CLIENT_ID (and TIDAL_CLIENT_SECRET) in .env first.');
const redirect = new URL(redirectUri);
if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)) {
  fail('TIDAL_REDIRECT_URI must be a http://localhost address for this helper.');
}

const verifier = randomBytes(48).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('base64url');
const authorizeUrl = `${AUTHORIZE_URL}?${new URLSearchParams({
  response_type: 'code',
  client_id: clientId,
  redirect_uri: redirectUri,
  scope: scopes,
  code_challenge_method: 'S256',
  code_challenge: challenge,
  state,
})}`;

async function exchangeCode(code) {
  const body = new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: redirectUri, code_verifier: verifier });
  if (clientSecret) body.set('client_secret', clientSecret);
  const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`TIDAL refused the sign-in (${res.status}): ${payload.error_description || payload.error || res.statusText}`);
  if (!payload.refresh_token) throw new Error('TIDAL did not return a refresh token.');
  return payload;
}

async function findUserId(tokens) {
  const fromToken = tokens.user_id ?? tokens.user?.userId;
  if (fromToken) return String(fromToken);
  try {
    const res = await fetch(`${API_URL}/users/me`, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/vnd.api+json' } });
    if (res.ok) return (await res.json())?.data?.id ?? null;
  } catch {
    // Not essential: with a refresh token the app can use "me".
  }
  return null;
}

function saveToEnv(values) {
  const lines = existsSync('.env') ? readFileSync('.env', 'utf8').split('\n') : [];
  for (const [key, value] of Object.entries(values)) {
    if (!value) continue;
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index === -1) lines.push(`${key}=${value}`);
    else lines[index] = `${key}=${value}`;
  }
  writeFileSync('.env', `${lines.join('\n').replace(/\n*$/, '')}\n`, { mode: 0o600 });
}

const page = (title, message) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;padding:3rem;background:#000;color:#fff"><h1>${title}</h1><p>${message}</p></body>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);
  if (url.pathname !== redirect.pathname) return res.writeHead(404).end();

  const respond = (status, title, message) => res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(page(title, message));
  try {
    if (url.searchParams.get('error')) throw new Error(`TIDAL said: ${url.searchParams.get('error_description') || url.searchParams.get('error')}`);
    if (url.searchParams.get('state') !== state) throw new Error('The sign-in response did not match this request. Please run the command again.');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('TIDAL did not send an authorisation code.');

    const tokens = await exchangeCode(code);
    const userId = await findUserId(tokens);
    respond(200, 'Signed in ✓', 'You can close this tab and return to the terminal.');

    console.log('\n✔ Signed in to TIDAL.\n');
    if (save) {
      saveToEnv({ TIDAL_REFRESH_TOKEN: tokens.refresh_token, TIDAL_USER_ID: userId });
      console.log('Saved TIDAL_REFRESH_TOKEN' + (userId ? ' and TIDAL_USER_ID' : '') + ' to .env.');
    } else {
      console.log('Add these to .env (and to your host’s environment settings):\n');
      console.log(`  TIDAL_REFRESH_TOKEN=${tokens.refresh_token}`);
      if (userId) console.log(`  TIDAL_USER_ID=${userId}`);
    }
    console.log('\nKeep the refresh token secret: it grants read access to your TIDAL account.\n');
    server.close(() => process.exit(0));
  } catch (error) {
    respond(400, 'Sign-in failed', error.message);
    server.close(() => fail(error.message));
  }
});

server.on('error', (error) => {
  fail(error.code === 'EADDRINUSE' ? `Port ${redirect.port} is in use. Stop the app (or whatever uses it) and try again.` : error.message);
});

server.listen(Number(redirect.port) || 80, '127.0.0.1', () => {
  console.log('\nOpen this link to sign in to TIDAL:\n');
  console.log(`  ${authorizeUrl}\n`);
  console.log(`Waiting for TIDAL to redirect back to ${redirectUri} …`);
  setTimeout(() => server.close(() => fail('Timed out waiting for the sign-in. Run the command again.')), TIMEOUT_MS).unref();
});
