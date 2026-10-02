import express from 'express';
import { badRequest, notFound } from '../lib/errors.js';
import { encryptJSON } from '../lib/crypto.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  getProviderConfig,
  isConfigured,
  pkcePair,
  resolveAccount,
} from '../oauth/index.js';

/**
 * Authorisation-code flow for each network. After the redirect back we resolve
 * who authorised us, store the encrypted tokens and redirect to the dashboard.
 */
export function createOauthRouter({ repo, config, transport }) {
  const router = express.Router();

  const redirectUriFor = (req, provider) => `${config.publicBaseUrl}/oauth/${provider}/callback`;

  router.get('/:provider/start', (req, res) => {
    const provider = String(req.params.provider);
    const def = getProviderConfig(provider);
    if (!def) throw notFound(`Unknown provider "${provider}"`);
    if (!isConfigured(provider, config)) {
      throw badRequest(
        `${def.label} is not configured on this server. Set ${def.envKeys.clientId} and ${def.envKeys.clientSecret} in .env, then restart.`,
      );
    }
    const { verifier, challenge } = def.pkce ? pkcePair() : { verifier: null, challenge: null };
    const state = repo.oauthStates.create({
      provider,
      verifier,
      redirectUri: redirectUriFor(req, provider),
      meta: { returnTo: req.query.return_to || '/#connections' },
    });
    const url = buildAuthorizeUrl(provider, {
      state,
      redirectUri: redirectUriFor(req, provider),
      codeChallenge: challenge,
      config,
    });
    res.redirect(302, url);
  });

  router.get('/:provider/callback', async (req, res) => {
    const provider = String(req.params.provider);
    const { code, state, error, error_description: errorDescription } = req.query;
    if (error) throw badRequest(`Provider returned an error: ${error} ${errorDescription ?? ''}`);
    if (!code || !state) throw badRequest('Missing code or state');

    const stored = repo.oauthStates.consume(String(state));
    if (!stored) throw badRequest('This sign-in link expired — start the connection again');
    if (stored.provider !== provider) throw badRequest('State does not match provider');

    const tokens = await exchangeCode(provider, {
      code: String(code),
      redirectUri: stored.redirectUri,
      verifier: stored.verifier,
      config,
      transport,
    });

    let account = { accountId: null, displayName: provider, meta: {} };
    try {
      account = await resolveAccount(provider, { accessToken: tokens.accessToken, config, transport });
    } catch {
      /* the account lookup is best-effort; tokens are what matter */
    }

    const meta = { ...(account.meta ?? {}) };
    const storedTokens = { ...tokens };
    if (account.pageAccessToken) {
      meta.pageAccessToken = account.pageAccessToken;
      storedTokens.pageAccessToken = account.pageAccessToken;
    }
    if (account.longLivedAccessToken) storedTokens.longLivedAccessToken = account.longLivedAccessToken;

    const connection = repo.connections.upsert({
      provider,
      accountId: account.accountId ?? `unknown-${Date.now()}`,
      displayName: account.displayName,
      tokens: encryptJSON(storedTokens, config.secret),
      scopes: tokens.scope ? String(tokens.scope).split(/[ ,]/).filter(Boolean) : [],
      sandbox: false,
      meta,
    });

    res.redirect(302, `${stored.meta?.returnTo ?? '/'}?connected=${encodeURIComponent(connection.id)}`);
  });

  return router;
}
