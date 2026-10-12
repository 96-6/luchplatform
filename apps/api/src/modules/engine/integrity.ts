import { randomUUID } from 'node:crypto';
import {
  integrityStatsSchema,
  type IntegrityAssessment,
  type IntegrityPacket,
  type IntegrityStats,
} from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import type { Actor } from '../auth/service.js';
import { AppError } from '../../errors.js';
import { audit } from '../accounts/repository.js';
import { canonicalJson } from '../content/service.js';
import { lockRun, type RunRow, type TurnRow } from './repository.js';

export async function integrityPolicy(db: QueryExecutor) {
  return {
    enabled:
      (
        await db.query<{ enabled: boolean }>(
          'SELECT enabled FROM engine_integrity_policy WHERE id=1',
        )
      ).rows[0]?.enabled ?? true,
  };
}
export async function setIntegrityPolicy(db: Database, actor: Actor, enabled: boolean) {
  await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO engine_integrity_policy (id,enabled,updated_by) VALUES (1,$1,$2) ON CONFLICT (id) DO UPDATE SET enabled=$1,updated_by=$2,updated_at=now()',
      [enabled, actor.user.id],
    );
    await audit(tx, actor.user.id, 'learning.integrity_policy_changed');
  });
  return { enabled };
}
export async function receiveIntegrity(
  db: Database,
  actor: Actor,
  id: string,
  input: IntegrityPacket,
) {
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, id, actor, true),
      policy = await integrityPolicy(tx);
    if (!policy.enabled) return { accepted: false, monitored: false };
    const previous = (
      await tx.query<{ stats: unknown }>(
        'SELECT stats FROM engine_integrity_packets WHERE turn_id=$1 AND actor_id=$2 AND batch_id=$3',
        [input.turnId, actor.user.id, input.batchId],
      )
    ).rows[0];
    if (previous) {
      if (canonicalJson(previous.stats) !== canonicalJson(input.stats))
        throw new AppError(409, 'OBSERVATION_CONFLICT', 'Операция уже сохранена.');
      return { accepted: true, monitored: true };
    }
    const turn = (
      await tx.query<TurnRow>(
        'SELECT t.* FROM engine_turns t JOIN engine_steps s ON s.id=t.step_id WHERE t.id=$1 AND s.run_id=$2',
        [input.turnId, id],
      )
    ).rows[0];
    if (!turn || turn.state !== 'open' || run.status !== 'active')
      return { accepted: false, monitored: true };
    const count = Number(
      (
        await tx.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM engine_integrity_packets WHERE turn_id=$1',
          [input.turnId],
        )
      ).rows[0]!.count,
    );
    if (count >= 1000) return { accepted: false, monitored: true };
    await tx.query(
      'INSERT INTO engine_integrity_packets (id,batch_id,turn_id,actor_id,stats,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        input.batchId,
        input.turnId,
        actor.user.id,
        JSON.stringify(input.stats),
        new Date(),
      ],
    );
    return { accepted: true, monitored: true };
  });
}
export async function recordIntegrity(
  tx: QueryExecutor,
  run: RunRow,
  turn: TurnRow,
  attemptId: string,
  now: number,
): Promise<IntegrityAssessment> {
  const policy = await integrityPolicy(tx);
  const rows = policy.enabled
    ? (
        await tx.query<{ stats: unknown }>(
          'SELECT stats FROM engine_integrity_packets WHERE turn_id=$1 AND actor_id=$2 ORDER BY created_at,id',
          [turn.id, run.user_id],
        )
      ).rows
    : [];
  const stats: IntegrityStats = integrityStatsSchema.parse({ durationMilliseconds: 0 });
  for (const row of rows) {
    const packet = integrityStatsSchema.parse(row.stats);
    for (const key of [
      'durationMilliseconds',
      'hiddenMilliseconds',
      'tabHides',
      'focusLosses',
      'returns',
      'pointerSamples',
      'pointerDistance',
      'fastMoves',
      'straightMoves',
      'syntheticEvents',
      'inputEvents',
      'pasteEvents',
      'copyEvents',
    ] as const)
      stats[key] += packet[key];
    stats.keyboardNavigation ||= packet.keyboardNavigation;
    stats.pointerTypes = [...new Set([...stats.pointerTypes, ...packet.pointerTypes])];
  }
  const signals: IntegrityAssessment['signals'] = [];
  if (policy.enabled && rows.length) {
    if (stats.tabHides + stats.focusLosses > 0)
      signals.push({
        code: 'window_changes',
        label: 'Уход из окна упражнения',
        source: 'browser',
        context: `Скрытия: ${stats.tabHides}; потери фокуса: ${stats.focusLosses}.`,
      });
    if (stats.pasteEvents > 0)
      signals.push({
        code: 'answer_paste',
        label: 'Вставка в ответ',
        source: 'browser',
        context: `Событий: ${stats.pasteEvents}.`,
      });
    const keyboardOnly = stats.keyboardNavigation && !stats.pointerTypes.includes('mouse');
    if (
      !keyboardOnly &&
      (stats.syntheticEvents >= 4 ||
        (stats.pointerSamples >= 20 && stats.fastMoves >= 8 && stats.straightMoves >= 15))
    )
      signals.push({
        code: 'pointer_pattern',
        label: 'Нетипичные события ввода',
        source: 'browser',
        context: 'Нужна оценка в контексте устройства и доступности.',
      });
    if (now - new Date(turn.started_at).getTime() < 1200)
      signals.push({
        code: 'short_response_interval',
        label: 'Короткий интервал ответа',
        source: 'server',
        context: 'Время само по себе не подтверждает нарушение.',
      });
  }
  const requiresReview =
    signals.length >= 2 &&
    (signals.some((signal) => signal.code === 'answer_paste') ||
      signals.some((signal) => signal.code === 'pointer_pattern'));
  const assessment: IntegrityAssessment = {
    status:
      !policy.enabled || !rows.length
        ? 'insufficient_data'
        : requiresReview
          ? 'review'
          : 'no_concerns',
    requiresReview,
    assessorVersion: '1.0.0',
    evaluatedAt: new Date(now).toISOString(),
    signals,
    packetCount: rows.length,
    stats,
  };
  await tx.query(
    'INSERT INTO engine_integrity_assessments (attempt_id,turn_id,assessment,requires_review,created_at) VALUES ($1,$2,$3,$4,$5)',
    [attemptId, turn.id, JSON.stringify(assessment), requiresReview, new Date(now)],
  );
  return assessment;
}
