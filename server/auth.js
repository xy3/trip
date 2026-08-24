/* Sign-in with Google, by hand: the authorization-code flow is a redirect, a
   form POST and a JSON GET, which is not worth a dependency. It runs with
   PKCE, plus a single-use `state` cookie tying the callback to the browser
   that started it.

   PROVIDERS is a map because adding a second provider later is then just
   another entry plus its two environment variables — nothing else in the
   server or the client is provider-specific. */
import { createHash, randomBytes } from 'node:crypto';
import { token } from './db.js';

const s256 = v => createHash('sha256').update(v).digest('base64url');

export const PROVIDERS = {
  google: {
    label: 'Google',
    scope: 'openid email profile',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenURL: 'https://oauth2.googleapis.com/token',
    pkce: true,
    async profile(accessToken) {
      const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) throw new Error(`Google profile failed (${r.status})`);
      const u = await r.json();
      return { providerId: u.sub, email: u.email, name: u.name || u.email, avatar: u.picture };
    },
  },
};

/* Which providers are actually configured — the sign-in UI only offers these. */
export const configured = env =>
  Object.keys(PROVIDERS).filter(p =>
    env[`${p.toUpperCase()}_CLIENT_ID`] && env[`${p.toUpperCase()}_CLIENT_SECRET`]);

export function startURL(name, env, baseURL) {
  const p = PROVIDERS[name];
  const state = token(16);
  const verifier = p.pkce ? randomBytes(32).toString('base64url') : null;
  const params = new URLSearchParams({
    client_id: env[`${name.toUpperCase()}_CLIENT_ID`],
    redirect_uri: `${baseURL}/auth/${name}/callback`,
    response_type: 'code',
    scope: p.scope,
    state,
  });
  if (verifier) {
    params.set('code_challenge', s256(verifier));
    params.set('code_challenge_method', 'S256');
  }
  return { url: `${p.authorize}?${params}`, state, verifier };
}

export async function exchange(name, code, verifier, env, baseURL) {
  const p = PROVIDERS[name];
  const body = new URLSearchParams({
    client_id: env[`${name.toUpperCase()}_CLIENT_ID`],
    client_secret: env[`${name.toUpperCase()}_CLIENT_SECRET`],
    code,
    grant_type: 'authorization_code',
    redirect_uri: `${baseURL}/auth/${name}/callback`,
  });
  if (verifier) body.set('code_verifier', verifier);

  const r = await fetch(p.tokenURL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(data.error_description || data.error || `token exchange failed (${r.status})`);

  const profile = await p.profile(data.access_token);
  if (!profile.providerId) throw new Error('provider returned no account id');
  return { provider: name, ...profile };
}
