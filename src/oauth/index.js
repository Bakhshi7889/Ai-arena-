import crypto from 'node:crypto';
import { AdapterError } from '../lib/errors.js';

const GRAPH_VERSION = 'v21.0';

/**
 * OAuth 2.0 provider definitions. Everything Posterly needs to run the
 * authorisation-code flow (with PKCE where the provider supports it) and to
 * refresh tokens without provider-specific code in the routes.
 */
export const OAUTH_PROVIDERS = {
  youtube: {
    label: 'YouTube',
    provider: 'youtube',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/youtube.upload', 'openid', 'email', 'profile'],
    pkce: true,
    extraAuthorizeParams: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    envKeys: { clientId: 'YOUTUBE_CLIENT_ID', clientSecret: 'YOUTUBE_CLIENT_SECRET' },
  },
  tiktok: {
    label: 'TikTok',
    provider: 'tiktok',
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['user.info.basic', 'video.upload', 'video.publish'],
    pkce: true,
    extraAuthorizeParams: {},
    tokenContentType: 'json',
    envKeys: { clientId: 'TIKTOK_CLIENT_KEY', clientSecret: 'TIKTOK_CLIENT_SECRET' },
  },
  facebook: {
    label: 'Facebook + Instagram',
    provider: 'facebook',
    authorizeUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
    scopes: [
      'pages_show_list',
      'pages_manage_posts',
      'pages_read_engagement',
      'instagram_basic',
      'instagram_content_publish',
    ],
    pkce: false,
    extraAuthorizeParams: {},
    envKeys: { clientId: 'FACEBOOK_APP_ID', clientSecret: 'FACEBOOK_APP_SECRET' },
  },
  x: {
    label: 'X (Twitter)',
    provider: 'x',
    authorizeUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    scopes: ['tweet.write', 'users.read', 'offline.access', 'media.write'],
    pkce: true,
    extraAuthorizeParams: {},
    envKeys: { clientId: 'X_CLIENT_ID', clientSecret: 'X_CLIENT_SECRET' },
  },
  linkedin: {
    label: 'LinkedIn',
    provider: 'linkedin',
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['openid', 'profile', 'email', 'w_member_social'],
    pkce: true,
    extraAuthorizeParams: {},
    envKeys: { clientId: 'LINKEDIN_CLIENT_ID', clientSecret: 'LINKEDIN_CLIENT_SECRET' },
  },
};

export const OAUTH_PROVIDER_IDS = Object.keys(OAUTH_PROVIDERS);

export function getProviderConfig(provider) {
  return OAUTH_PROVIDERS[provider] ?? null;
}

export function isConfigured(provider, config) {
  const keys = OAUTH_PROVIDERS[provider]?.envKeys;
  if (!keys) return false;
  return Boolean(config.oauth?.[provider]?.clientId && config.oauth?.[provider]?.clientSecret);
}

export function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

export function buildAuthorizeUrl(provider, { state, redirectUri, codeChallenge, config, scopeOverride }) {
  const def = getProviderConfig(provider);
  if (!def) throw new AdapterError(`Unknown OAuth provider "${provider}"`, { retryable: false });
  const creds = config.oauth?.[provider] ?? {};
  if (!creds.clientId) {
    throw new AdapterError(`${def.label} is not configured — set ${def.envKeys.clientId} / ${def.envKeys.clientSecret}`, {
      code: 'oauth_not_configured',
      retryable: false,
    });
  }
  const url = new URL(def.authorizeUrl);
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('scope', (scopeOverride ?? def.scopes).join(' '));
  for (const [k, v] of Object.entries(def.extraAuthorizeParams)) url.searchParams.set(k, v);
  if (def.pkce && codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/** Exchange the authorisation code for tokens. */
export async function exchangeCode(provider, { code, redirectUri, verifier, config, transport }) {
  const def = getProviderConfig(provider);
  const creds = config.oauth?.[provider] ?? {};
  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  };
  if (def.pkce && verifier) params.code_verifier = verifier;

  const useJson = def.tokenContentType === 'json';
  const res = await transport.request({
    method: 'POST',
    url: def.tokenUrl,
    headers: {
      'content-type': useJson ? 'application/json' : 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    ...(useJson ? { json: params } : { form: params }),
  });
  const body = res.json() ?? {};
  if (!res.ok || !body.access_token) {
    throw new AdapterError(`Token exchange failed for ${def.label} (HTTP ${res.status}): ${res.text().slice(0, 300)}`, {
      code: 'oauth_token_exchange_failed',
      retryable: false,
    });
  }
  return normalizeTokenResponse(body);
}

export async function refreshTokens(provider, { refreshToken, config, transport }) {
  const def = getProviderConfig(provider);
  const creds = config.oauth?.[provider] ?? {};
  const useJson = def.tokenContentType === 'json';
  const params = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  };
  const res = await transport.request({
    method: 'POST',
    url: def.tokenUrl,
    headers: { 'content-type': useJson ? 'application/json' : 'application/x-www-form-urlencoded', accept: 'application/json' },
    ...(useJson ? { json: params } : { form: params }),
  });
  const body = res.json() ?? {};
  if (!res.ok || !body.access_token) {
    throw new AdapterError(`Token refresh failed for ${def.label} (HTTP ${res.status})`, {
      code: 'oauth_refresh_failed',
      retryable: false,
    });
  }
  const normalized = normalizeTokenResponse(body);
  // Providers may omit the refresh token on refresh — keep the old one.
  return { ...normalized, refreshToken: normalized.refreshToken ?? refreshToken };
}

function normalizeTokenResponse(body) {
  const expiresAt = body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt,
    tokenType: body.token_type ?? 'Bearer',
    scope: body.scope ?? null,
    raw: body,
  };
}

/** Look up who just authorised us, so a connection is human-recognisable. */
export async function resolveAccount(provider, { accessToken, config, transport }) {
  switch (provider) {
    case 'youtube': {
      const res = await transport.request({
        method: 'GET',
        url: 'https://www.googleapis.com/oauth2/v3/userinfo',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const info = res.json() ?? {};
      return { accountId: info.sub ?? null, displayName: info.email ?? info.name ?? 'YouTube', meta: { email: info.email } };
    }
    case 'tiktok': {
      const res = await transport.request({
        method: 'GET',
        url: 'https://open.tiktokapis.com/v2/user/info/',
        query: { fields: 'open_id,display_name,avatar_url,username' },
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const data = res.json()?.data?.user ?? {};
      return {
        accountId: data.open_id ?? null,
        displayName: data.display_name || data.username || 'TikTok',
        meta: { username: data.username, avatarUrl: data.avatar_url },
      };
    }
    case 'x': {
      const res = await transport.request({
        method: 'GET',
        url: 'https://api.x.com/2/users/me',
        query: { 'user.fields': 'username,name' },
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const user = res.json()?.data ?? {};
      return { accountId: user.id ?? null, displayName: user.username ? `@${user.username}` : 'X account', meta: { username: user.username, name: user.name } };
    }
    case 'linkedin': {
      const res = await transport.request({
        method: 'GET',
        url: 'https://api.linkedin.com/v2/userinfo',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const info = res.json() ?? {};
      return { accountId: info.sub ?? null, displayName: info.email ?? info.name ?? 'LinkedIn', meta: { email: info.email, name: info.name } };
    }
    case 'facebook':
      return resolveFacebookAccount({ accessToken, transport });
    default:
      return { accountId: null, displayName: provider, meta: {} };
  }
}

/**
 * Facebook connects a Page (for Page video) and, if present, the linked
 * Instagram Business account (for Reels). We upgrade to a long-lived token and
 * store the page token, because Page publishing requires it.
 */
export async function resolveFacebookAccount({ accessToken, transport, config }) {
  const graph = `https://graph.facebook.com/${GRAPH_VERSION}`;

  let longLived = accessToken;
  const creds = config?.oauth?.facebook ?? {};
  if (creds.clientId && creds.clientSecret) {
    const up = await transport.request({
      method: 'GET',
      url: `${graph}/oauth/access_token`,
      query: {
        grant_type: 'fb_exchange_token',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        fb_exchange_token: accessToken,
      },
    });
    if (up.ok && up.json()?.access_token) longLived = up.json().access_token;
  }

  const accountsRes = await transport.request({
    method: 'GET',
    url: `${graph}/me/accounts`,
    query: { fields: 'id,name,access_token', access_token: longLived },
  });
  const pages = accountsRes.json()?.data ?? [];
  const page = pages[0];

  const meRes = await transport.request({
    method: 'GET',
    url: `${graph}/me`,
    query: { fields: 'id,name,instagram_business_account', access_token: longLived },
  });
  const me = meRes.json() ?? {};
  let instagram = null;
  if (me.instagram_business_account?.id) {
    const igRes = await transport.request({
      method: 'GET',
      url: `${graph}/${me.instagram_business_account.id}`,
      query: { fields: 'user_id,username', access_token: longLived },
      });
    const ig = igRes.json() ?? {};
    instagram = { id: ig.user_id ?? me.instagram_business_account.id, username: ig.username };
  }

  return {
    accountId: page?.id ?? me.id ?? null,
    displayName: page?.name ?? me.name ?? 'Facebook',
    meta: {
      pageId: page?.id ?? null,
      pageName: page?.name ?? null,
      pageCount: pages.length,
      pages: pages.map((p) => ({ id: p.id, name: p.name })),
      instagramAccountId: instagram?.id ?? null,
      instagramUsername: instagram?.username ?? null,
    },
    /** Page-scoped token is what Page/Reels publishing needs. */
    pageAccessToken: page?.access_token ?? null,
    longLivedAccessToken: longLived,
  };
}

/** Tokens expire — refresh proactively so a publish never fails on a stale one. */
export function isExpiringSoon(tokens, skewMs = 60_000) {
  if (!tokens?.expiresAt) return false;
  return tokens.expiresAt - Date.now() < skewMs;
}
