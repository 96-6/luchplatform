import { randomUUID } from 'node:crypto';
import {
  maintenanceOperationSchema,
  operationsOverviewSchema,
  type MaintenanceKind,
} from '@luch/contracts';
import type { Database } from '../../db/database.js';
import { assertSchemaCurrent } from '../../db/migrations.js';
import type { Settings } from '../../config.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import { recoverLearningEvents, learningEventsReady } from '../adaptation/processor.js';
import { expireSpeechAudio } from '../speech/repository.js';
import { seedDemoContent } from '../content/bootstrap.js';
import type { MeetingsService } from '../meetings/service.js';

const allowed = (actor: Actor): MaintenanceKind[] =>
  actor.user.role === 'superadmin'
    ? ['recover_learning', 'retry_video', 'seed_content', 'expire_audio']
    : actor.user.role === 'admin'
      ? ['recover_learning', 'retry_video']
      : [];
const operationSelect =
  'SELECT o.*,u.full_name AS actor_name FROM platform_operations o JOIN users u ON u.id=o.actor_id';
function operation(row: Record<string, unknown>) {
  return maintenanceOperationSchema.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    actorName: row.actor_name,
    createdAt: new Date(row.created_at as string).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
    result: row.result,
  });
}
export class OperationsService {
  constructor(
    readonly db: Database,
    readonly settings: Settings,
    readonly meetings: MeetingsService,
    readonly now: () => number = Date.now,
  ) {}
  private requireOperator(actor: Actor) {
    if (!['admin', 'superadmin'].includes(actor.user.role))
      throw new AppError(403, 'OPERATOR_REQUIRED', 'Раздел доступен администратору и суперадмину.');
  }
  async overview(actor: Actor) {
    this.requireOperator(actor);
    await assertSchemaCurrent(this.db);
    const r = (
      await this.db.query(
        `SELECT
      (SELECT count(*)::integer FROM users WHERE role='student') AS students,
      (SELECT count(*)::integer FROM users WHERE role='teacher') AS teachers,
      (SELECT count(*)::integer FROM learning_routes r JOIN content_packages p ON p.id=r.package_id AND p.current_version=r.package_version) AS routes,
      (SELECT count(*)::integer FROM learning_lessons l JOIN content_packages p ON p.id=l.package_id AND p.current_version=l.package_version) AS lessons,
      (SELECT count(*)::integer FROM scheduled_meetings WHERE status='live') AS live_meetings,
      (SELECT count(*)::integer FROM scheduled_meetings WHERE status='scheduled') AS scheduled_meetings,
      (SELECT count(*)::integer FROM engine_events v JOIN engine_attempts a ON a.id=v.attempt_id JOIN engine_runs r ON r.id=a.run_id WHERE v.attempt_id IS NOT NULL AND v.processed_at IS NULL AND ${learningEventsReady}) AS learning_ready,
      (SELECT count(*)::integer FROM engine_events v JOIN engine_attempts a ON a.id=v.attempt_id JOIN engine_runs r ON r.id=a.run_id WHERE v.attempt_id IS NOT NULL AND v.processed_at IS NULL AND NOT ${learningEventsReady}) AS learning_deferred,
      (SELECT count(*)::integer FROM meeting_commands WHERE status='pending') AS video_pending,
      (SELECT count(*)::integer FROM speech_inputs WHERE status='error') AS speech_errors,
      (SELECT count(*)::integer FROM provider_requests WHERE status='unknown') AS unknown_requests,
      (SELECT count(*)::integer FROM speech_inputs WHERE audio IS NOT NULL AND audio_expires_at<=$1) AS expired_audio`,
        [new Date(this.now())],
      )
    ).rows[0]!;
    const version = (
      await this.db.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      )
    ).rows[0]!.version;
    const providers = (
      await this.db.query<{ id: string; configured: boolean; key_disabled: boolean }>(
        'SELECT id,key_disabled,(credential_ciphertext IS NOT NULL) AS configured FROM external_providers',
      )
    ).rows;
    const configured = (id: string, fallback: string) =>
      Boolean(
        !providers.find((p) => p.id === id)?.key_disabled &&
        (providers.find((p) => p.id === id)?.configured || fallback),
      );
    const recent = (
      await this.db.query(`${operationSelect} ORDER BY o.created_at DESC,o.id DESC LIMIT 20`)
    ).rows;
    return operationsOverviewSchema.parse({
      database: 'ready',
      schemaVersion: version,
      refreshedAt: new Date(this.now()).toISOString(),
      canManagePlatform: actor.user.role === 'superadmin',
      counts: {
        students: r.students,
        teachers: r.teachers,
        routes: r.routes,
        lessons: r.lessons,
        liveMeetings: r.live_meetings,
        scheduledMeetings: r.scheduled_meetings,
        learningReady: r.learning_ready,
        learningDeferred: r.learning_deferred,
        videoPending: r.video_pending,
        speechErrors: r.speech_errors,
        unknownProviderRequests: r.unknown_requests,
        expiredAudio: r.expired_audio,
      },
      integrations: [
        {
          id: 'video',
          title: 'Видеозанятия LiveKit',
          configured: Boolean(this.settings.LIVEKIT_URL && this.settings.LIVEKIT_API_SECRET),
          detail: 'Настройка подключения не означает, что внешний сервер сейчас доступен.',
        },
        {
          id: 'mail',
          title: 'Почта',
          configured:
            this.settings.MAIL_MODE === 'local'
              ? this.settings.APP_ENV !== 'production' && this.settings.ENABLE_DEV_TOOLS
              : Boolean(this.settings.SMTP_HOST),
          detail:
            this.settings.MAIL_MODE === 'local'
              ? 'Локальная демо-почта.'
              : this.settings.SMTP_HOST
                ? 'Параметры SMTP заданы на сервере; доставка зависит от почтового сервиса.'
                : 'Требуется первичная настройка SMTP оператором сервера.',
        },
        {
          id: 'openai',
          title: 'OpenAI',
          configured: configured('openai', this.settings.OPENAI_API_KEY),
          detail: 'Ключи, цены, разрешения и бюджеты — в разделе AI и расходов.',
        },
        {
          id: 'neuroapi',
          title: 'NeuroAPI',
          configured: configured('neuroapi', this.settings.NEUROAPI_API_KEY),
          detail: 'Банк заданий доступен и без генерации.',
        },
        {
          id: 'elevenlabs_stt',
          title: 'ElevenLabs Scribe',
          configured: configured('elevenlabs_stt', this.settings.ELEVENLABS_API_KEY),
          detail: 'Технические ошибки распознавания не влияют на учебную оценку.',
        },
        {
          id: 'heygen',
          title: 'Видеоаватары HeyGen',
          configured: configured('heygen', this.settings.HEYGEN_API_KEY),
          detail: 'Платные повторы выполняются только из соответствующего учебного действия.',
        },
      ],
      actions: allowed(actor),
      recentOperations: recent.map(operation),
    });
  }
  async execute(actor: Actor, input: { operationId: string; kind: MaintenanceKind }) {
    this.requireOperator(actor);
    if (!allowed(actor).includes(input.kind))
      throw new AppError(403, 'SUPERADMIN_REQUIRED', 'Эта операция доступна только суперадмину.');
    const claim = await this.db.transaction(async (tx) => {
      const id = randomUUID();
      const inserted = (
        await tx.query(
          'INSERT INTO platform_operations (id,actor_id,operation_id,kind,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (actor_id,operation_id) DO NOTHING RETURNING id',
          [id, actor.user.id, input.operationId, input.kind, new Date(this.now())],
        )
      ).rows[0];
      if (inserted) {
        await audit(tx, actor.user.id, 'platform.operation_started', actor.user.id);
        return { id, fresh: true };
      }
      const row = (
        await tx.query(`${operationSelect} WHERE o.actor_id=$1 AND o.operation_id=$2`, [
          actor.user.id,
          input.operationId,
        ])
      ).rows[0]!;
      if (row.kind !== input.kind)
        throw new AppError(
          409,
          'OPERATION_CONFLICT',
          'Этот номер операции уже использован для другого действия.',
        );
      if (row.status === 'running')
        throw new AppError(
          409,
          'OPERATION_IN_PROGRESS',
          'Операция ещё выполняется. Обновите сводку; после прерывания можно запустить новое действие.',
        );
      return { id: row.id as string, fresh: false };
    });
    if (claim.fresh) {
      let status = 'completed',
        result: { message: string; processed?: number };
      try {
        if (input.kind === 'recover_learning') {
          const processed = await recoverLearningEvents(this.db, this.now, 50);
          result = {
            message:
              'Сохранённые учебные события обработаны. Незавершённые закрытые наборы пропущены; при оставшейся очереди запустите следующую порцию.',
            processed,
          };
        } else if (input.kind === 'retry_video') {
          if (!this.meetings.video.configured)
            throw new AppError(
              503,
              'VIDEO_NOT_CONFIGURED',
              'Видеосервер не подключён. Настройте подключение; сохранённая очередь не изменена.',
            );
          await this.meetings.drain();
          result = {
            message:
              'Проверены готовые команды видеосервера. При недоступности сервера очередь сохраняется; следующее действие не создаёт новых команд.',
          };
        } else if (input.kind === 'seed_content') {
          const imported = await seedDemoContent(this.db, actor.user.id);
          result = {
            message:
              imported.status === 'unchanged'
                ? 'Демоматериалы уже загружены. Дубликаты не созданы.'
                : 'Демоматериалы загружены. Аккаунты и прежние ответы не изменены.',
          };
        } else {
          const processed = await this.db.transaction((tx) => expireSpeechAudio(tx, this.now()));
          result = {
            message:
              'Удалены только истёкшие сырые аудиозаписи. Распознанный текст, ответы, оценки и озвучивание сохранены.',
            processed,
          };
        }
      } catch (error) {
        status = 'failed';
        result = {
          message:
            error instanceof AppError
              ? error.message
              : 'Операция не завершена. Сохранённые результаты остаются в базе. Обновите сводку и повторите отдельным действием.',
        };
      }
      await this.db.transaction(async (tx) => {
        await tx.query(
          'UPDATE platform_operations SET status=$2,result=$3,completed_at=$4 WHERE id=$1',
          [claim.id, status, result, new Date(this.now())],
        );
        await audit(
          tx,
          actor.user.id,
          status === 'completed' ? 'platform.operation_completed' : 'platform.operation_failed',
          actor.user.id,
        );
      });
    }
    return operation(
      (await this.db.query(`${operationSelect} WHERE o.id=$1`, [claim.id])).rows[0]!,
    );
  }
}
