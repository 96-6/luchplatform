import type { z } from 'zod';
import { meetingRecordingPolicySchema } from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';

export async function recordingPolicy(tx: QueryExecutor) {
  const row = (
    await tx.query<{ enabled: boolean; revision: number }>(
      'SELECT enabled,revision FROM meeting_recording_policy WHERE id=1',
    )
  ).rows[0];
  return meetingRecordingPolicySchema.parse(row ?? { enabled: false, revision: 1 });
}

export async function updateRecordingPolicy(
  db: Database,
  actor: Actor,
  input: z.infer<typeof meetingRecordingPolicySchema>,
) {
  if (actor.user.role !== 'superadmin')
    throw new AppError(403, 'ACCESS_DENIED', 'Доступ запрещён.');
  return db.transaction(async (tx) => {
    await tx.query('INSERT INTO meeting_recording_policy(id) VALUES(1) ON CONFLICT DO NOTHING');
    const result = await tx.query(
      'UPDATE meeting_recording_policy SET enabled=$1,revision=revision+1,updated_at=now(),updated_by=$2 WHERE id=1 AND revision=$3 RETURNING id',
      [input.enabled, actor.user.id, input.revision],
    );
    if (!result.rows.length)
      throw new AppError(409, 'SETTINGS_CHANGED', 'Настройки уже изменены. Обновите страницу.');
    await audit(tx, actor.user.id, 'meeting.recording_policy_changed');
    return recordingPolicy(tx);
  });
}
