import { randomUUID } from 'node:crypto';
import {
  questionnaireSchema,
  startRunSchema,
  type startDiagnosticSchema,
  type diagnosticsQuerySchema,
} from '@luch/contracts';
import type { z } from 'zod';
import type { Database } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { AppError } from '../../errors.js';
import { audit } from '../accounts/repository.js';
import { LuchEngine } from '../engine/service.js';
import { ProfileService, studentAccess, type ProfileRow } from './profile.js';
import {
  diagnosticSelect,
  diagnosticSummary,
  readDiagnostic,
  type DiagnosticRow,
} from './repository.js';

export class DiagnosticsService {
  readonly engine: LuchEngine;
  readonly profiles: ProfileService;
  constructor(readonly db: Database) {
    this.engine = new LuchEngine(db);
    this.profiles = new ProfileService(db);
  }
  async start(actor: Actor, input: z.infer<typeof startDiagnosticSchema>) {
    const userId = input.userId ?? actor.user.id;
    const id = await this.db.transaction(async (tx) => {
      await studentAccess(tx, actor, userId, true);
      if (this.db.kind === 'postgres')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `diagnostic:${userId}`,
        ]);
      const profile = (
        await tx.query<ProfileRow>('SELECT * FROM student_profiles WHERE user_id=$1 FOR SHARE', [
          userId,
        ])
      ).rows[0];
      if (!profile) throw new AppError(409, 'PROFILE_REQUIRED', 'Сначала сохраните анкету.');
      if (profile.revision !== input.profileRevision)
        throw new AppError(409, 'PROFILE_CHANGED', 'Анкета уже изменена. Обновите страницу.');
      const questionnaire = questionnaireSchema.parse(profile.questionnaire);
      const previous = (
        await tx.query<DiagnosticRow>(
          `${diagnosticSelect} WHERE d.user_id=$1 AND d.questionnaire->>'language'=$2 ORDER BY d.created_at DESC,d.id DESC LIMIT 1`,
          [userId, questionnaire.language],
        )
      ).rows[0];
      if (previous && (previous.status === 'active' || !input.restart)) return previous.id;
      const revision = await this.engine.content.revision('luch-demo', undefined, tx);
      const route = revision.manifest.routes.find(
        (r) => r.language === questionnaire.language && r.level === 'A1',
      );
      const set = revision.manifest.sets.find(
        (s) => s.purpose === 'diagnostic' && s.routeId === route?.id,
      );
      if (!route || !set)
        throw new AppError(
          404,
          'DIAGNOSTIC_BANK_MISSING',
          'Диагностические материалы этого языка не загружены.',
        );
      let runId = await this.engine.startInTransaction(
        tx,
        actor,
        startRunSchema.parse({
          packageId: revision.packageId,
          packageVersion: revision.packageVersion,
          source: { type: 'set', id: set.id },
          userId,
          restart: input.restart,
        }),
      );
      const linked = (
        await tx.query<{ id: string }>('SELECT id FROM diagnostic_sessions WHERE run_id=$1', [
          runId,
        ])
      ).rows[0];
      if (linked) return linked.id;
      const run = (
        await tx.query<{ status: string }>('SELECT status FROM engine_runs WHERE id=$1', [runId])
      ).rows[0]!;
      // A standalone bank attempt cannot become an entry diagnostic after answers were exposed.
      const used =
        (await tx.query('SELECT 1 FROM engine_attempts WHERE run_id=$1 LIMIT 1', [runId])).rows
          .length > 0;
      if (used && run.status === 'active')
        throw new AppError(
          409,
          'BANK_IN_PROGRESS',
          'Завершите ранее начатый диагностический набор в разделе «Обучение», затем начните входную диагностику.',
        );
      if (run.status === 'completed')
        runId = await this.engine.startInTransaction(
          tx,
          actor,
          startRunSchema.parse({
            packageId: revision.packageId,
            packageVersion: revision.packageVersion,
            source: { type: 'set', id: set.id },
            userId,
            restart: true,
          }),
        );
      const diagnosticId = randomUUID();
      await tx.query(
        'INSERT INTO diagnostic_sessions (id,user_id,profile_revision,questionnaire,run_id,package_id,package_version,route_id,set_id,created_by,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
        [
          diagnosticId,
          userId,
          profile.revision,
          JSON.stringify(questionnaire),
          runId,
          revision.packageId,
          revision.packageVersion,
          route.id,
          set.id,
          actor.user.id,
          new Date(),
        ],
      );
      await audit(tx, actor.user.id, 'diagnostic.started', userId);
      return diagnosticId;
    });
    return this.read(actor, id);
  }
  async read(actor: Actor, id: string) {
    return this.db.transaction((tx) => readDiagnostic(tx, actor, id));
  }
  async list(actor: Actor, query: z.infer<typeof diagnosticsQuerySchema>) {
    const userId = query.userId ?? actor.user.id;
    await studentAccess(this.db, actor, userId);
    const rows = (
      await this.db.query<DiagnosticRow>(
        `${diagnosticSelect} WHERE d.user_id=$1
      AND ($2::timestamptz IS NULL OR (d.created_at,d.id)<($2::timestamptz,$3::uuid))
      ORDER BY d.created_at DESC,d.id DESC LIMIT $4`,
        [userId, query.beforeCreatedAt ?? null, query.beforeId ?? null, query.limit + 1],
      )
    ).rows;
    const items = rows.slice(0, query.limit).map(diagnosticSummary),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > query.limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    };
  }
}
