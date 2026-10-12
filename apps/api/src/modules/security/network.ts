import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import ipaddr from 'ipaddr.js';
import {
  probeTargetSchema,
  type NetworkEvidence,
  type Observation,
  type User,
} from '@luch/contracts';
import type { Settings } from '../../config.js';
import type { Database } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { AccountCrypto } from '../auth/crypto.js';
import { getPolicy, ipAllowed, normalizeIp } from './policy.js';

export const VPN_MESSAGE = 'вы используете VPN - сервис недоступен';
const intelSchema = z.object({
  vpn: z.boolean().optional(),
  proxy: z.boolean().optional(),
  tor: z.boolean().optional(),
  hosting: z.boolean().optional(),
  timezone: z.string().max(80).optional(),
  hostname: z.string().max(254).optional(),
  openProxyPorts: z.array(z.number().int().min(1).max(65535)).max(20).optional(),
  openVpnPorts: z.array(z.number().int().min(1).max(65535)).max(20).optional(),
  dnsLeak: z.boolean().optional(),
  vpnFingerprint: z.boolean().optional(),
  tunnel: z.boolean().optional(),
});
export type IpIntel = z.infer<typeof intelSchema>;
export type IpInspector = (ip: string) => Promise<IpIntel | null>;
const cookieName = 'luch_network';
type AssessmentRow = {
  id: string;
  ip: string;
  denied: boolean;
  policy_revision: number;
  created_at: Date | string;
};

export class NetworkService {
  constructor(
    private readonly db: Database,
    private readonly settings: Settings,
    private readonly crypto: AccountCrypto,
    private readonly inspector?: IpInspector,
  ) {}
  probeTargets() {
    if (!this.settings.NETWORK_PROBE_URLS)
      return [
        { id: 'youtube' as const, url: 'https://i.ytimg.com/vi/jNQXAC9IVRw/hqdefault.jpg' },
        { id: 'telegram' as const, url: 'https://telegram.org/img/t_logo.png' },
        { id: 'whatsapp' as const, url: 'https://web.whatsapp.com/favicon-64x64.ico' },
      ];
    const result = z
      .array(probeTargetSchema)
      .max(3)
      .parse(JSON.parse(this.settings.NETWORK_PROBE_URLS));
    if (result.some((target) => new URL(target.url).protocol !== 'https:'))
      throw new Error('Network resource settings require HTTPS.');
    return result;
  }
  stunUrls() {
    return this.settings.NETWORK_STUN_URLS.split(',')
      .map((value) => value.trim())
      .filter((value) => /^(stun|stuns):/.test(value))
      .slice(0, 2);
  }
  async fetchIntel(ip: string): Promise<IpIntel | null> {
    if (this.inspector) return this.inspector(ip);
    if (!this.settings.IP_INTEL_URL || ipaddr.process(ip).range() !== 'unicast') return null;
    try {
      const url = new URL(this.settings.IP_INTEL_URL);
      url.searchParams.set('ip', ip);
      const response = await fetch(url, {
        headers: this.settings.IP_INTEL_KEY
          ? { authorization: `Bearer ${this.settings.IP_INTEL_KEY}` }
          : {},
        signal: AbortSignal.timeout(3000),
        redirect: 'error',
      });
      if (!response.ok) return null;
      const parsed = intelSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
  async evaluate(request: FastifyRequest, reply: FastifyReply, evidence: NetworkEvidence) {
    const policy = await getPolicy(this.db);
    if (!policy.vpnCheckEnabled) {
      reply.clearCookie(cookieName, { path: '/' });
      return { allowed: true, message: null };
    }
    const ip = normalizeIp(request.ip);
    const intel = await this.fetchIntel(ip);
    const observations: Observation[] = [];
    const families = new Set<string>();
    const add = (
      label: string,
      value: boolean | undefined,
      family: string,
      source: Observation['source'],
      strength: Observation['strength'] = 'supporting',
    ) => {
      observations.push({
        label,
        status: value === undefined ? 'unknown' : value ? 'observed' : 'not_observed',
        source,
        strength,
      });
      if (value === true) families.add(family);
    };
    add(
      'HTTP proxy headers',
      Boolean(request.headers['via'] || request.headers['proxy-connection']),
      'headers',
      'server',
      'weak',
    );
    add(
      'Open HTTP proxy ports',
      intel?.openProxyPorts?.some((port) => [80, 8080, 3128].includes(port)),
      'ports',
      'provider',
    );
    add('Open web proxy ports', intel?.proxy, 'ports', 'provider');
    add(
      'Open VPN ports',
      intel?.openVpnPorts ? intel.openVpnPorts.length > 0 : undefined,
      'ports',
      'provider',
    );
    add(
      'Suspicious hostname',
      intel?.hostname ? /proxy|vpn|tor-exit/i.test(intel.hostname) : undefined,
      'hostname',
      'provider',
      'weak',
    );
    add(
      'Browser and IP time zones differ',
      intel?.timezone && evidence.timezone ? intel.timezone !== evidence.timezone : undefined,
      'timezone',
      'client',
      'weak',
    );
    add('Tor network', intel?.tor, 'tor', 'provider');
    add('Browser Turbo mode', evidence.turboMode, 'browser', 'client', 'weak');
    add('Hosting provider IP pool', intel?.hosting, 'hosting', 'provider');
    add('Web proxy JS observation', evidence.jsProxyHint, 'browser', 'client', 'weak');
    add(
      'Tunnel observation',
      intel?.tunnel ??
        (evidence.latencyMs?.length === 2
          ? evidence.latencyMs.every((value) => value > 1500)
          : undefined),
      'tunnel',
      'client',
      'weak',
    );
    add('DNS leak', intel?.dnsLeak, 'dns', 'provider');
    add('VPN fingerprint', intel?.vpnFingerprint ?? intel?.vpn, 'fingerprint', 'provider');
    let rtcMismatch: boolean | undefined;
    if (evidence.webrtcIp) {
      try {
        rtcMismatch = normalizeIp(evidence.webrtcIp) !== ip;
      } catch {}
    }
    add('WebRTC IP mismatch', rtcMismatch, 'ip-mismatch', 'client');
    for (const target of this.probeTargets()) {
      add(
        `${target.id} resource available`,
        evidence.resourceResults?.find((item) => item.id === target.id)?.loaded,
        'external-resources',
        'client',
        'weak',
      );
    }
    const denied = families.size >= 2 || !ipAllowed(ip, policy.ipAllowlist);
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO network_assessments (id,ip,policy_revision,observations,denied) VALUES ($1,$2,$3,$4,$5)',
      [id, ip, policy.revision, JSON.stringify(observations), denied],
    );
    reply.setCookie(cookieName, `${id}.${this.crypto.mac(id)}`, {
      httpOnly: true,
      secure: this.settings.APP_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 600,
    });
    return { allowed: !denied, message: denied ? VPN_MESSAGE : null };
  }
  async current(request: FastifyRequest): Promise<AssessmentRow | null> {
    const value = request.cookies[cookieName];
    if (!value) return null;
    const [id, signature] = value.split('.');
    if (
      !id ||
      !signature ||
      !z.uuid().safeParse(id).success ||
      !this.crypto.matches(signature, this.crypto.mac(id))
    )
      return null;
    const result = await this.db.query<AssessmentRow>(
      'SELECT id,ip,denied,policy_revision,created_at FROM network_assessments WHERE id=$1',
      [id],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.ip !== normalizeIp(request.ip) ||
      Date.now() - new Date(row.created_at).getTime() > 600000
    )
      return null;
    return row;
  }
  async check(request: FastifyRequest, user?: User, requireAssessment = true) {
    const policy = await getPolicy(this.db);
    if (!policy.vpnCheckEnabled) return;
    if (!ipAllowed(normalizeIp(request.ip), policy.ipAllowlist))
      throw new AppError(403, 'VPN_ACCESS_DENIED', VPN_MESSAGE);
    const assessment = await this.current(request);
    if (assessment?.policy_revision === policy.revision && assessment.denied)
      throw new AppError(403, 'VPN_ACCESS_DENIED', VPN_MESSAGE);
    if (requireAssessment && (!assessment || assessment.policy_revision !== policy.revision))
      throw new AppError(
        403,
        'NETWORK_CHECK_REQUIRED',
        'Выполните проверку соединения перед входом.',
      );
    if (user && !user.accessVerified)
      throw new AppError(403, 'ACCESS_REVIEW_REQUIRED', 'Доступ ожидает проверки администратором.');
  }
  async linkUser(request: FastifyRequest, userId: string) {
    const assessment = await this.current(request);
    if (assessment)
      await this.db.query('UPDATE network_assessments SET user_id=$1 WHERE id=$2', [
        userId,
        assessment.id,
      ]);
  }
}
