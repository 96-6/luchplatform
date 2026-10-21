import type { FastifyInstance, InjectOptions } from 'fastify';
import { Passwords } from '../../src/modules/auth/password.js';
import type { AccountCrypto } from '../../src/modules/auth/crypto.js';

// Synthetic fixture credential, never used by bootstrap or real/demo accounts.
export const fixturePassword = 'Test fixture password 2026!';
const hashes = new WeakMap<AccountCrypto, Promise<string>>();
export function fixturePasswordHash(crypto: AccountCrypto) {
  let value = hashes.get(crypto);
  if (!value) {
    value = new Passwords(crypto).protect(fixturePassword);
    hashes.set(crypto, value);
  }
  return value;
}
export async function passwordLogin(app: FastifyInstance, options: InjectOptions) {
  const input = options.payload as { email: string; code: string; captcha?: unknown };
  const first = await app.inject({
    ...options,
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: {
      email: input.email,
      password: fixturePassword,
      ...(input.captcha ? { captcha: input.captcha } : {}),
    },
  });
  if (first.statusCode !== 200 || first.json().data.step !== 'totp') return first;
  const challenge = first.cookies.find((c) => c.name === 'luch_login')!;
  const originalCookie = options.headers?.cookie;
  return app.inject({
    ...options,
    method: 'POST',
    url: '/api/v1/auth/login/confirm',
    payload: { code: input.code },
    headers: {
      ...options.headers,
      cookie: `${originalCookie ? originalCookie + '; ' : ''}luch_login=${challenge.value}`,
      'x-login-csrf': first.json().data.csrfToken,
    },
  });
}
