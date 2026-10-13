import {
  questionnaireSchema,
  studentProfileSchema,
  type StudentProfile,
  type saveQuestionnaireSchema,
} from '@luch/contracts';
import type { z } from 'zod';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { audit, publicUser, type UserRow } from '../accounts/repository.js';
import { assertUserAccess } from '../engine/repository.js';
import { canonicalJson } from '../content/service.js';

export type ProfileRow = {
  user_id: string;
  revision: number;
  questionnaire: unknown;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
};
export function profileView(row: ProfileRow): StudentProfile {
  return studentProfileSchema.parse({
    ...questionnaireSchema.parse(row.questionnaire),
    userId: row.user_id,
    revision: row.revision,
    updatedBy: row.updated_by,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  });
}
export async function studentAccess(
  tx: QueryExecutor,
  actor: Actor,
  userId: string,
  write = false,
) {
  await assertUserAccess(tx, actor, userId, write);
  const row = (await tx.query<UserRow>('SELECT * FROM users WHERE id=$1', [userId])).rows[0];
  if (!row) throw new AppError(404, 'STUDENT_NOT_FOUND', 'Ученик не найден.');
  if (row.role !== 'student')
    throw new AppError(403, 'STUDENT_PROFILE_REQUIRED', 'Анкета предназначена для ученика.');
  return row;
}
export class ProfileService {
  constructor(readonly db: Database) {}
  async read(actor: Actor, userId = actor.user.id) {
    const view = await this.db.transaction(async (tx) => {
      const user = await studentAccess(tx, actor, userId);
      const row = (
        await tx.query<ProfileRow>('SELECT * FROM student_profiles WHERE user_id=$1', [userId])
      ).rows[0];
      if (actor.user.role === 'superadmin')
        await audit(tx, actor.user.id, 'profile.debug_view', userId);
      return {
        user: publicUser(user),
        profile: row ? profileView(row) : null,
        writable: actor.user.id === userId || actor.user.role === 'superadmin',
      };
    });
    return view;
  }
  async save(actor: Actor, input: z.infer<typeof saveQuestionnaireSchema>) {
    const userId = input.userId ?? actor.user.id;
    const data = questionnaireSchema.parse({
      language: input.language,
      goal: input.goal,
      experience: input.experience,
      minutesPerDay: input.minutesPerDay,
    });
    await this.db.transaction(async (tx) => {
      await studentAccess(tx, actor, userId, true);
      if (this.db.kind === 'postgres')
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `profile:${userId}`,
        ]);
      const row = (
        await tx.query<ProfileRow>('SELECT * FROM student_profiles WHERE user_id=$1 FOR UPDATE', [
          userId,
        ])
      ).rows[0];
      if (row && canonicalJson(row.questionnaire) === canonicalJson(data)) return;
      if (input.revision !== (row?.revision ?? 0))
        throw new AppError(409, 'PROFILE_CHANGED', 'Анкета уже изменена. Обновите страницу.');
      const revision = (row?.revision ?? 0) + 1,
        now = new Date();
      await tx.query(
        'INSERT INTO student_profiles (user_id,revision,questionnaire,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (user_id) DO UPDATE SET revision=$2,questionnaire=$3,updated_by=$4,updated_at=$5',
        [userId, revision, JSON.stringify(data), actor.user.id, now],
      );
      await tx.query(
        'INSERT INTO student_profile_revisions (user_id,revision,questionnaire,created_by,created_at) VALUES ($1,$2,$3,$4,$5)',
        [userId, revision, JSON.stringify(data), actor.user.id, now],
      );
      await audit(tx, actor.user.id, 'profile.saved', userId);
    });
    return this.read(actor, userId);
  }
}
