import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  DEFAULT_BROWSER_POLICY,
  BROWSER_WARNING_MESSAGE,
  browserPolicySchema,
  browserEvidenceSchema,
  type BrowserPolicy,
  type browserDecisionSchema,
} from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { AuthService } from '../auth/service.js';
import { hashToken, token } from '../auth/crypto.js';
import { audit } from '../accounts/repository.js';
import { limitAttempts } from './rate.js';
import { browserSignals, evaluateBrowser, type BrowserSignals } from './browsers-detection.js';
import { BrowserManualAccess } from './browser-access.js';
import { registerBrowserManualRoutes } from './browser-access-routes.js';

type Decision = z.infer<typeof browserDecisionSchema>;
type Assessment = {
  client_hash: string;
  header_hash: string;
  policy_revision: number;
  signals: BrowserSignals;
  decision: Decision;
  verified_until: Date | string;
  notice_acknowledged: boolean;
};
const HOUR = 3600000,
  DAY = 24 * HOUR;
export async function getBrowserPolicy(db: QueryExecutor): Promise<BrowserPolicy> {
  const row = (
    await db.query<{
      outdated_enabled: boolean;
      enhanced_enabled: boolean;
      blocked_browsers: unknown;
      allowed_browsers: unknown;
      minimum_versions: unknown;
      revision: number;
    }>('SELECT * FROM browser_policy WHERE id=1')
  ).rows[0];
  return row
    ? browserPolicySchema.parse({
        outdatedEnabled: row.outdated_enabled,
        enhancedEnabled: row.enhanced_enabled,
        blockedBrowsers: row.blocked_browsers,
        allowedBrowsers: row.allowed_browsers,
        minimumVersions: row.minimum_versions,
        revision: row.revision,
      })
    : structuredClone(DEFAULT_BROWSER_POLICY);
}
export class BrowserService {
  readonly cookie: string;
  readonly manual: BrowserManualAccess;
  constructor(
    readonly db: Database,
    readonly auth: AuthService,
    readonly now = Date.now,
  ) {
    this.cookie = auth.settings.APP_ENV === 'production' ? '__Host-luch_browser' : 'luch_browser';
    this.manual = new BrowserManualAccess(auth, now);
  }
  private client(request: FastifyRequest) {
    const value = request.cookies[this.cookie];
    return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? hashToken(value) : null;
  }
  private header(request: FastifyRequest) {
    return this.auth.crypto.mac(`browser-header:${request.headers['user-agent'] ?? ''}`);
  }
  private noticeToken(client: string | null) {
    return client ? this.auth.crypto.mac(`browser-notice:${client}`) : '';
  }
  private async current(request: FastifyRequest, tx: QueryExecutor = this.db) {
    const client = this.client(request);
    if (!client) return null;
    const row = (
      await tx.query<Assessment>(
        'SELECT * FROM browser_assessments WHERE client_hash=$1 AND expires_at>$2',
        [client, new Date(this.now())],
      )
    ).rows[0];
    return row && row.header_hash === this.header(request) ? row : null;
  }
  private valid(row: Assessment | null, p: BrowserPolicy) {
    return (
      row &&
      row.policy_revision === p.revision &&
      new Date(row.verified_until).getTime() > this.now()
    );
  }
  async bootstrap(request: FastifyRequest, reply: FastifyReply, force: boolean) {
    const p = await getBrowserPolicy(this.db);
    if (await this.manual.allowed(request))
      return {
        enabled: true,
        policyRevision: p.revision,
        challenge: null,
        decision: this.manualDecision(request, p),
        noticeToken: '',
      };
    const partial = evaluateBrowser(p, browserSignals(request.headers), false);
    if (!partial.allowed || (!force && !p.outdatedEnabled && !p.enhancedEnabled))
      return {
        enabled: p.outdatedEnabled || p.enhancedEnabled,
        policyRevision: p.revision,
        challenge: null,
        decision: partial,
        noticeToken: '',
      };
    const current = await this.current(request);
    if (!force && this.valid(current, p))
      return {
        enabled: true,
        policyRevision: p.revision,
        challenge: null,
        decision: current!.decision,
        noticeToken: this.noticeToken(this.client(request)),
      };
    await limitAttempts(this.db, this.auth.crypto, `browser-challenge:${request.ip}`, 240);
    let client = this.client(request);
    if (!client) {
      const value = token();
      client = hashToken(value);
      reply.setCookie(this.cookie, value, {
        path: '/',
        httpOnly: true,
        sameSite: 'strict',
        secure: this.auth.settings.APP_ENV === 'production',
        maxAge: (30 * DAY) / 1000,
      });
    }
    const id = randomUUID(),
      nonce = token(),
      expiresAt = new Date(this.now() + 120000);
    await this.db.query(
      'INSERT INTO browser_challenges(id,client_hash,nonce_hash,header_hash,policy_revision,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [id, client, hashToken(nonce), this.header(request), p.revision, expiresAt],
    );
    return {
      enabled: true,
      policyRevision: p.revision,
      challenge: { id, nonce, expiresAt: expiresAt.toISOString() },
      decision: null,
      noticeToken: this.noticeToken(client),
    };
  }
  async assess(request: FastifyRequest, input: z.infer<typeof browserEvidenceSchema>) {
    if (await this.manual.allowed(request))
      return {
        decision: this.manualDecision(request, await getBrowserPolicy(this.db)),
        noticeToken: '',
      };
    const p = await getBrowserPolicy(this.db),
      client = this.client(request);
    if (!client)
      throw new AppError(403, 'BROWSER_CHALLENGE_INVALID', 'Повторите проверку браузера.');
    await limitAttempts(this.db, this.auth.crypto, `browser-assess:${request.ip}`, 240);
    const signals = browserSignals(request.headers, input.page, input.worker, input.features);
    const decision = evaluateBrowser(p, signals, true);
    await this.db.transaction(async (tx) => {
      const live = (
        await tx.query<{ revision: number }>(
          'SELECT revision FROM browser_policy WHERE id=1 FOR SHARE',
        )
      ).rows[0];
      if (live && live.revision !== p.revision)
        throw new AppError(403, 'BROWSER_CHALLENGE_INVALID', 'Повторите проверку браузера.');
      const used = await tx.query(
        'UPDATE browser_challenges SET consumed_at=$1 WHERE id=$2 AND client_hash=$3 AND nonce_hash=$4 AND header_hash=$5 AND policy_revision=$6 AND expires_at>$1 AND consumed_at IS NULL RETURNING id',
        [
          new Date(this.now()),
          input.challengeId,
          client,
          hashToken(input.nonce),
          this.header(request),
          p.revision,
        ],
      );
      if (!used.rows.length)
        throw new AppError(403, 'BROWSER_CHALLENGE_INVALID', 'Повторите проверку браузера.');
      await tx.query(
        `INSERT INTO browser_assessments(client_hash,header_hash,policy_revision,signals,decision,verified_until,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(client_hash) DO UPDATE SET
         header_hash=excluded.header_hash,policy_revision=excluded.policy_revision,signals=excluded.signals,
         decision=excluded.decision,verified_until=excluded.verified_until,expires_at=excluded.expires_at,
         notice_acknowledged=CASE WHEN browser_assessments.decision->>'family'=excluded.decision->>'family' THEN browser_assessments.notice_acknowledged ELSE false END`,
        [
          client,
          this.header(request),
          p.revision,
          JSON.stringify(signals),
          JSON.stringify(decision),
          new Date(this.now() + 2 * HOUR),
          new Date(this.now() + 30 * DAY),
        ],
      );
    });
    return { decision, noticeToken: this.noticeToken(client) };
  }
  async check(request: FastifyRequest, document = false) {
    if (await this.manual.allowed(request)) return;
    const p = await getBrowserPolicy(this.db);
    if (!p.outdatedEnabled && !p.enhancedEnabled) return;
    const signals = browserSignals(request.headers);
    const partial = evaluateBrowser(p, signals, false);
    if (!partial.allowed) throw new AppError(403, 'BROWSER_INCOMPATIBLE', partial.message!);
    // Documents contain only the SPA shell. Domain APIs remain gated until the independent check completes.
    if (document) return;
    // Compatibility mode also permits non-browser API tooling. Strict mode has no such exception.
    const browserRequest =
      signals.identities.some((s) => s.family !== 'unknown') ||
      Boolean(request.headers['sec-fetch-mode']);
    if (!p.enhancedEnabled && !browserRequest) return;
    const row = await this.current(request);
    if (!this.valid(row, p))
      throw new AppError(428, 'BROWSER_CHECK_REQUIRED', 'Выполните проверку браузера.');
    const decision = evaluateBrowser(p, row!.signals, true);
    if (!decision.allowed) throw new AppError(403, 'BROWSER_INCOMPATIBLE', decision.message!);
  }
  async update(request: FastifyRequest, input: BrowserPolicy) {
    const actor = await this.auth.requireActor(request, 'superadmin', true);
    return this.db.transaction(async (tx) => {
      const row = await this.current(request, tx);
      const signals = row?.signals ?? browserSignals(request.headers);
      if (
        !(await this.manual.current(request, tx)) &&
        (input.outdatedEnabled || input.enhancedEnabled) &&
        (!row ||
          new Date(row.verified_until).getTime() <= this.now() ||
          !evaluateBrowser(input, signals, true).allowed)
      )
        throw new AppError(
          409,
          'SELF_LOCKOUT',
          'Новые правила закроют ваш доступ. Сначала проверьте браузер и разрешите его.',
        );
      await tx.query('INSERT INTO browser_policy(id) VALUES(1) ON CONFLICT DO NOTHING');
      const updated = await tx.query(
        'UPDATE browser_policy SET outdated_enabled=$1,enhanced_enabled=$2,blocked_browsers=$3,allowed_browsers=$4,minimum_versions=$5,revision=revision+1,updated_at=$6,updated_by=$7 WHERE id=1 AND revision=$8 RETURNING revision',
        [
          input.outdatedEnabled,
          input.enhancedEnabled,
          JSON.stringify(input.blockedBrowsers),
          JSON.stringify(input.allowedBrowsers),
          JSON.stringify(input.minimumVersions),
          new Date(this.now()),
          actor.user.id,
          input.revision,
        ],
      );
      if (!updated.rows.length)
        throw new AppError(409, 'SETTINGS_CHANGED', 'Настройки уже изменены. Обновите страницу.');
      await audit(tx, actor.user.id, 'browser.policy_changed');
      const policy = await getBrowserPolicy(tx);
      if (row)
        await tx.query(
          'UPDATE browser_assessments SET policy_revision=$1,decision=$2 WHERE client_hash=$3',
          [
            policy.revision,
            JSON.stringify(evaluateBrowser(policy, signals, true)),
            row.client_hash,
          ],
        );
      return policy;
    });
  }
  async notice(request: FastifyRequest) {
    if (await this.manual.current(request)) return { show: false, message: null };
    const p = await getBrowserPolicy(this.db),
      row = await this.current(request);
    if (!this.valid(row, p) || !row!.decision.warning || !p.outdatedEnabled)
      return { show: false, message: null };
    const actor = await this.auth.actor(request);
    const acknowledged = actor
      ? (
          await this.db.query(
            'SELECT 1 FROM browser_notice_acknowledgements WHERE user_id=$1 AND browser=$2',
            [actor.user.id, row!.decision.family],
          )
        ).rows.length > 0
      : row!.notice_acknowledged;
    return { show: !acknowledged, message: acknowledged ? null : BROWSER_WARNING_MESSAGE };
  }
  async acknowledge(request: FastifyRequest, noticeToken: string) {
    const row = await this.current(request),
      client = this.client(request);
    if (!row || !client || !this.auth.crypto.matches(noticeToken, this.noticeToken(client)))
      throw new AppError(403, 'INVALID_REQUEST', 'Обновите страницу и повторите действие.');
    const actor = await this.auth.actor(request);
    if (actor) this.auth.checkCsrf(request, actor);
    await this.db.transaction(async (tx) => {
      if (actor)
        await tx.query(
          'INSERT INTO browser_notice_acknowledgements(user_id,browser) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [actor.user.id, row.decision.family],
        );
      else
        await tx.query(
          'UPDATE browser_assessments SET notice_acknowledged=true WHERE client_hash=$1',
          [client],
        );
    });
    return { show: false, message: null };
  }
  async cleanup() {
    await this.db.query('DELETE FROM browser_challenges WHERE expires_at<$1', [
      new Date(this.now() - DAY),
    ]);
    await this.db.query('DELETE FROM browser_assessments WHERE expires_at<$1', [
      new Date(this.now()),
    ]);
  }
  private manualDecision(request: FastifyRequest, p: BrowserPolicy): Decision {
    return {
      allowed: true,
      warning: false,
      family: browserSignals(request.headers).identities[0]?.family ?? 'unknown',
      reason: 'manual',
      message: null,
      policyRevision: p.revision,
    };
  }
}
export async function registerBrowserSecurity(app: FastifyInstance, auth: AuthService) {
  const service = new BrowserService(auth.database, auth);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('accept-ch', 'Sec-CH-UA-Full-Version-List');
    const path = request.url.split('?')[0]!;
    const publicPath = [
      '/api/v1/security/bootstrap',
      '/api/v1/security/ping',
      '/api/v1/security/evaluate',
      '/api/v1/security/browser/bootstrap',
      '/api/v1/security/browser/assess',
      '/api/v1/auth/logout',
      '/api/v1/health/live',
      '/api/v1/health/ready',
      '/browser-check-worker.js',
      '/favicon.svg',
      '/browser-access',
    ];
    if (
      publicPath.includes(path) ||
      /^\/assets\/[A-Za-z0-9_/-]+\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|ico)$/.test(path) ||
      /^\/avatars\/(?:mentor|partner|guide)\.svg$/.test(path) ||
      path === '/audio/pcm-recorder.js'
    )
      return;
    await service.check(
      request,
      (!path.startsWith('/api/') && !path.startsWith('/learning-media/')) ||
        path === '/api/v1/navigation/access',
    );
  });
  app.get('/api/v1/security/browser/bootstrap', async (r, reply) => {
    const query = z.strictObject({ force: z.enum(['true', 'false']).optional() }).parse(r.query);
    return { data: await service.bootstrap(r, reply, query.force === 'true'), requestId: r.id };
  });
  app.post('/api/v1/security/browser/assess', { bodyLimit: 24 * 1024 }, async (r) => ({
    data: await service.assess(r, browserEvidenceSchema.parse(r.body)),
    requestId: r.id,
  }));
  app.get('/api/v1/security/browser/notice', async (r) => ({
    data: await service.notice(r),
    requestId: r.id,
  }));
  app.post('/api/v1/security/browser/notice', async (r) => ({
    data: await service.acknowledge(
      r,
      z.strictObject({ token: z.string().length(64) }).parse(r.body).token,
    ),
    requestId: r.id,
  }));
  app.get('/api/v1/admin/browser-policy', async (r) => {
    await auth.requireActor(r, 'superadmin');
    return {
      data: await getBrowserPolicy(auth.database),
      requestId: r.id,
    };
  });
  app.post('/api/v1/admin/browser-policy', async (r) => ({
    data: await service.update(r, browserPolicySchema.parse(r.body)),
    requestId: r.id,
  }));
  await registerBrowserManualRoutes(app, service.manual);
  let work: Promise<void> | null = null;
  const timer =
    auth.settings.APP_ENV !== 'test'
      ? setInterval(() => {
          work ??= service
            .cleanup()
            .catch(() => {
              app.log.warn('Browser policy cleanup will retry.');
            })
            .finally(() => {
              work = null;
            });
        }, 600000)
      : null;
  timer?.unref();
  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    await work;
  });
}
