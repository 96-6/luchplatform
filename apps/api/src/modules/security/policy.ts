import ipaddr from 'ipaddr.js';
import type { SecurityPolicy } from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';

export function normalizeIp(value: string): string {
  return ipaddr.process(value).toString();
}
export function ipAllowed(ip: string, ranges: string[]): boolean {
  let address: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    address = ipaddr.process(ip);
  } catch {
    return false;
  }
  return ranges.some((range) => {
    try {
      const [network, prefix] = range.includes('/')
        ? ipaddr.parseCIDR(range)
        : ([ipaddr.process(range), range.includes(':') ? 128 : 32] as const);
      if (address.kind() !== network.kind()) return false;
      return address.match(network, prefix);
    } catch {
      return false;
    }
  });
}
export function validateRanges(ranges: string[]): string[] {
  for (const range of ranges) {
    try {
      if (range.includes('/')) ipaddr.parseCIDR(range);
      else ipaddr.process(range);
    } catch {
      throw new AppError(400, 'INVALID_NETWORK', 'Укажите корректный IP-адрес или CIDR.');
    }
  }
  return [...new Set(ranges)];
}
export async function getPolicy(db: QueryExecutor): Promise<SecurityPolicy> {
  const result = await db.query<{
    captcha_enabled: boolean;
    vpn_check_enabled: boolean;
    ip_allowlist: string[];
    session_hours: number;
    revision: number;
  }>('SELECT * FROM security_policy WHERE id = 1');
  const row = result.rows[0];
  if (!row) throw new AppError(503, 'POLICY_UNAVAILABLE', 'Настройки доступа временно недоступны.');
  return {
    captchaEnabled: row.captcha_enabled,
    vpnCheckEnabled: row.vpn_check_enabled,
    ipAllowlist: row.ip_allowlist,
    sessionHours: row.session_hours,
    revision: row.revision,
  };
}
