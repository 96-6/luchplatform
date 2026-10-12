import type { Database } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { AccountCrypto } from '../auth/crypto.js';

export async function limitAttempts(
  database: Database,
  crypto: AccountCrypto,
  scope: string,
  maximum = 12,
) {
  const now = new Date();
  const threshold = new Date(now.getTime() - 5 * 60 * 1000);
  const result = await database.query<{ attempts: number }>(
    `INSERT INTO auth_rate_limits (key_hash, window_started_at, attempts) VALUES ($1,$2,1)
     ON CONFLICT (key_hash) DO UPDATE SET
       attempts = CASE WHEN auth_rate_limits.window_started_at < $3 THEN 1 ELSE auth_rate_limits.attempts + 1 END,
       window_started_at = CASE WHEN auth_rate_limits.window_started_at < $3 THEN $2 ELSE auth_rate_limits.window_started_at END
     RETURNING attempts`,
    [crypto.mac(scope), now, threshold],
  );
  if ((result.rows[0]?.attempts ?? maximum + 1) > maximum)
    throw new AppError(429, 'TRY_LATER', 'Слишком много попыток. Подождите несколько минут.');
}
