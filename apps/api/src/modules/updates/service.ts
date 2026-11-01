import { randomUUID } from 'node:crypto';
import {
  updateOverviewSchema,
  type BuildInfo,
  type UpdateJob,
  type UpdateOverview,
} from '@luch/contracts';
import type { Database } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { AppError } from '../../errors.js';
import { audit } from '../accounts/repository.js';
import { GitHubUpdates } from './github.js';
import { UpdateSpool } from './spool.js';

const SIX_HOURS = 6 * 60 * 60 * 1000;
export async function activeMeetingCount(db: Database) {
  return Number(
    (
      await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM scheduled_meetings m WHERE m.status='live' AND EXISTS(SELECT 1 FROM meeting_sessions s WHERE s.meeting_id=m.id AND s.state='admitted')",
      )
    ).rows[0]!.n,
  );
}
const terminal = (phase: string) => ['completed', 'failed', 'rollback_failed'].includes(phase);
type Channel = {
  checked_at: Date | string | null;
  next_check_at: Date | string | null;
  checking_since: Date | string | null;
  latest_commit: string | null;
  latest_fingerprint: string | null;
  latest_committed_at: Date | string | null;
  last_error: string | null;
};
type JobRow = {
  id: string;
  actor_id: string;
  actor_name: string;
  operation_id: string;
  target_commit: string;
  phase: string;
  created_at: Date | string;
  completed_at: Date | string | null;
  restored: boolean;
};
const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const selectJob =
  'SELECT j.*,u.full_name AS actor_name FROM platform_update_jobs j JOIN users u ON u.id=j.actor_id';
export class UpdatesService {
  private pending: Promise<void> | null = null;
  private closed = false;
  private relation: { key: string; value: string } | null = null;
  constructor(
    readonly db: Database,
    readonly build: BuildInfo,
    readonly spool: UpdateSpool,
    readonly github = new GitHubUpdates(),
    readonly now = Date.now,
  ) {}
  async check(force: boolean) {
    if (this.closed) return;
    if (this.pending) return this.pending;
    this.pending = this.performCheck(force).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async close() {
    this.closed = true;
    await this.pending;
  }
  private async performCheck(force: boolean) {
    const claim = await this.db.query(
      'UPDATE platform_update_channel SET checking_since=$1 WHERE id=1 AND (checking_since IS NULL OR checking_since<$2) AND ($3::boolean OR next_check_at IS NULL OR next_check_at<=$1) RETURNING id',
      [new Date(this.now()), new Date(this.now() - 120000), force],
    );
    if (!claim.rows.length) return;
    try {
      const latest = await this.github.latest();
      await this.db.query(
        'UPDATE platform_update_channel SET checked_at=$1,next_check_at=$2,checking_since=NULL,latest_commit=$3,latest_fingerprint=$4,latest_committed_at=$5,last_error=NULL WHERE id=1',
        [
          new Date(this.now()),
          new Date(this.now() + SIX_HOURS),
          latest.commit,
          latest.fingerprint,
          new Date(latest.committedAt),
        ],
      );
      this.relation = null;
    } catch {
      await this.db.query(
        'UPDATE platform_update_channel SET checking_since=NULL,next_check_at=$1,last_error=$2 WHERE id=1',
        [
          new Date(this.now() + 15 * 60 * 1000),
          'Не удалось проверить GitHub. Повторите проверку позже.',
        ],
      );
    }
  }
  async reconcile() {
    const rows = (
      await this.db.query<JobRow>(
        selectJob + " WHERE j.phase NOT IN ('completed','failed','rollback_failed')",
      )
    ).rows;
    for (const row of rows) {
      const file = await this.spool.job(row.id);
      if (!file && row.phase === 'queued' && this.spool.directory) {
        await this.spool.enqueue(this.fallback(row));
        continue;
      }
      if (!file || file.targetCommit !== row.target_commit) continue;
      if (file.phase !== row.phase)
        await this.db.transaction(async (tx) => {
          const changed = await tx.query(
            "UPDATE platform_update_jobs SET phase=$2,completed_at=$3,restored=$4 WHERE id=$1 AND phase NOT IN ('completed','failed','rollback_failed') AND phase<>$2 RETURNING id",
            [row.id, file.phase, file.completedAt, file.restored],
          );
          if (changed.rows.length && terminal(file.phase))
            await audit(
              tx,
              row.actor_id,
              file.phase === 'completed' ? 'platform.update_completed' : 'platform.update_failed',
              row.actor_id,
            );
        });
    }
  }
  private fallback(row: JobRow): UpdateJob {
    return {
      id: row.id,
      targetCommit: row.target_commit,
      actorName: row.actor_name,
      phase: row.phase as UpdateJob['phase'],
      createdAt: iso(row.created_at)!,
      heartbeatAt: iso(row.created_at)!,
      completedAt: iso(row.completed_at),
      restored: row.restored,
      error: null,
      logs: [],
    };
  }
  async progress(id: string) {
    await this.reconcile();
    const row = (await this.db.query<JobRow>(selectJob + ' WHERE j.id=$1', [id])).rows[0];
    if (!row) throw new AppError(404, 'UPDATE_JOB_NOT_FOUND', 'Обновление не найдено.');
    const file = await this.spool.job(id);
    return {
      job:
        file?.targetCommit === row.target_commit
          ? { ...file, actorName: row.actor_name }
          : this.fallback(row),
      transport: 'application' as const,
    };
  }
  async overview(): Promise<UpdateOverview> {
    await this.reconcile();
    const c = (await this.db.query<Channel>('SELECT * FROM platform_update_channel WHERE id=1'))
      .rows[0]!;
    const jobs = (
      await this.db.query<JobRow>(selectJob + ' ORDER BY j.created_at DESC,j.id DESC LIMIT 20')
    ).rows;
    const live = await activeMeetingCount(this.db);
    let status: UpdateOverview['status'] = 'unknown';
    if (c.latest_commit) {
      if (this.build.fingerprint && this.build.fingerprint === c.latest_fingerprint)
        status = 'current';
      else if (this.build.modified) status = 'different';
      else if (this.build.commit && this.build.commit === c.latest_commit) status = 'different';
      else if (this.build.commit) {
        const key = this.build.commit + ':' + c.latest_commit;
        if (this.relation?.key !== key)
          try {
            this.relation = {
              key,
              value: await this.github.comparison(this.build.commit, c.latest_commit),
            };
          } catch {
            this.relation = { key, value: 'unknown' };
          }
        status =
          this.relation.value === 'ahead'
            ? 'outdated'
            : this.relation.value === 'behind'
              ? 'ahead'
              : this.relation.value === 'unknown'
                ? 'unknown'
                : 'different';
      } else if (this.build.fingerprint) status = 'different';
    }
    const latestJob = jobs[0] ? (await this.progress(jobs[0].id)).job : null;
    const agent = await this.spool.agent();
    const updateAvailable = status === 'outdated' || status === 'different';
    return updateOverviewSchema.parse({
      current: this.build,
      repository: '96-6/luchplatform',
      branch: 'main',
      status,
      updateAvailable,
      checking: Boolean(
        c.checking_since && this.now() - new Date(c.checking_since).getTime() < 120000,
      ),
      checkedAt: iso(c.checked_at),
      nextCheckAt: iso(c.next_check_at),
      lastError: c.last_error,
      latest: c.latest_commit
        ? {
            commit: c.latest_commit,
            fingerprint: c.latest_fingerprint!,
            committedAt: iso(c.latest_committed_at)!,
          }
        : null,
      agent,
      canUpdate:
        agent.available &&
        updateAvailable &&
        this.build.kind !== 'development' &&
        !this.build.modified &&
        !jobs.some((j) => !terminal(j.phase)),
      liveMeetings: live,
      latestJob,
      history: jobs.map((j) => ({
        id: j.id,
        targetCommit: j.target_commit,
        actorName: j.actor_name,
        phase: j.phase,
        createdAt: iso(j.created_at),
        completedAt: iso(j.completed_at),
        restored: j.restored,
      })),
    });
  }
  async start(actor: Actor, input: { operationId: string; targetCommit: string }) {
    if (actor.user.role !== 'superadmin')
      throw new AppError(403, 'ACCESS_DENIED', 'Доступ запрещён.');
    const old = (
      await this.db.query<JobRow>(selectJob + ' WHERE j.actor_id=$1 AND j.operation_id=$2', [
        actor.user.id,
        input.operationId,
      ])
    ).rows[0];
    if (old) {
      if (old.target_commit !== input.targetCommit)
        throw new AppError(
          409,
          'UPDATE_OPERATION_CONFLICT',
          'Этот номер операции уже использован для другой сборки.',
        );
      return (await this.progress(old.id)).job;
    }
    const view = await this.overview();
    if (!view.agent.available)
      throw new AppError(
        409,
        'UPDATER_UNAVAILABLE',
        'Управляемое обновление сервера не подключено или агент недоступен.',
      );
    if (!view.canUpdate)
      throw new AppError(
        409,
        'UPDATE_UNAVAILABLE',
        'Обновление сейчас недоступно. Проверьте состояние и версию сборки.',
      );
    if (
      view.latest?.commit !== input.targetCommit ||
      !view.checkedAt ||
      this.now() - Date.parse(view.checkedAt) > SIX_HOURS
    )
      throw new AppError(
        409,
        'UPDATE_TARGET_CHANGED',
        'Проверьте актуальную сборку GitHub перед обновлением.',
      );
    const job: UpdateJob = {
      id: randomUUID(),
      targetCommit: input.targetCommit,
      actorName: actor.user.name,
      phase: 'queued',
      createdAt: new Date(this.now()).toISOString(),
      heartbeatAt: new Date(this.now()).toISOString(),
      completedAt: null,
      restored: false,
      error: null,
      logs: [],
    };
    await this.db.transaction(async (tx) => {
      if (this.db.kind === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(75239314)');
      const previous = (
        await tx.query<JobRow>(selectJob + ' WHERE j.actor_id=$1 AND j.operation_id=$2', [
          actor.user.id,
          input.operationId,
        ])
      ).rows[0];
      if (previous) return;
      const active = await tx.query(
        "SELECT id FROM platform_update_jobs WHERE phase NOT IN ('completed','failed','rollback_failed')",
      );
      if (active.rows.length)
        throw new AppError(409, 'UPDATE_RUNNING', 'Другое обновление уже выполняется.');
      await tx.query(
        'INSERT INTO platform_update_jobs(id,actor_id,operation_id,target_commit,created_at) VALUES($1,$2,$3,$4,$5)',
        [job.id, actor.user.id, input.operationId, input.targetCommit, new Date(job.createdAt)],
      );
      await audit(tx, actor.user.id, 'platform.update_requested', actor.user.id);
    });
    const saved = (
      await this.db.query<JobRow>(selectJob + ' WHERE j.actor_id=$1 AND j.operation_id=$2', [
        actor.user.id,
        input.operationId,
      ])
    ).rows[0]!;
    if (saved.id !== job.id) return (await this.progress(saved.id)).job;
    try {
      await this.spool.enqueue(job);
    } catch {
      await this.db.query(
        "UPDATE platform_update_jobs SET phase='failed',completed_at=now() WHERE id=$1",
        [job.id],
      );
      throw new AppError(
        503,
        'UPDATER_WRITE_FAILED',
        'Не удалось передать задание агенту обновления.',
      );
    }
    return job;
  }
}
