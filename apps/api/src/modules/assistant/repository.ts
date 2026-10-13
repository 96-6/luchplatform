import {
  assistantContextSchema,
  assistantPreferencesSchema,
  type AssistantPreferences,
} from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { iso } from '../engine/repository.js';

export const avatars = [
  {
    id: 'mentor' as const,
    name: 'Мира',
    style: 'Спокойный наставник',
    description: 'Объясняет последовательно и даёт время подумать.',
    image: '/avatars/mentor.svg',
  },
  {
    id: 'partner' as const,
    name: 'Алекс',
    style: 'Деловой собеседник',
    description: 'Короткие объяснения и практичные ситуации общения.',
    image: '/avatars/partner.svg',
  },
  {
    id: 'guide' as const,
    name: 'Искра',
    style: 'Игровой проводник',
    description: 'Небольшие разговорные миссии без гонки за баллами.',
    image: '/avatars/guide.svg',
  },
];
export type AssistantProfileRow = { user_id: string; revision: number; preferences: unknown };
export type ExchangeRow = {
  id: string;
  user_id: string;
  run_id: string;
  step_id: string;
  turn_id: string;
  operation_id: string;
  request: unknown;
  context: unknown;
  preferences: unknown;
  action: 'explain' | 'hint' | 'dialogue';
  user_text: string;
  assistant_text: string;
  actor_id: string;
  sequence: string | number;
  created_at: Date | string;
};
export async function profileOf(tx: QueryExecutor, userId: string) {
  const row = (
    await tx.query<AssistantProfileRow>('SELECT * FROM assistant_profiles WHERE user_id=$1', [
      userId,
    ])
  ).rows[0];
  return {
    revision: row?.revision ?? 0,
    preferences: assistantPreferencesSchema.parse(row?.preferences ?? {}),
  };
}
export function messagesOf(rows: ExchangeRow[], debug = false) {
  return rows.flatMap((row) => {
    const preferences = assistantPreferencesSchema.parse(row.preferences);
    const shared = {
      action: row.action,
      avatarId: preferences.avatarId,
      stepId: row.step_id,
      turnId: row.turn_id,
      actorId: row.actor_id,
      createdAt: iso(row.created_at),
    };
    return [
      {
        ...shared,
        id: row.operation_id,
        role: 'user' as const,
        context: null,
        content:
          row.user_text ||
          {
            explain: 'Объясните задание.',
            hint: 'Нужна подсказка.',
            dialogue: 'Давайте поговорим по теме.',
          }[row.action],
      },
      {
        ...shared,
        id: row.id,
        role: 'assistant' as const,
        context: debug ? assistantContextSchema.parse(row.context) : null,
        content: row.assistant_text,
      },
    ];
  });
}
export async function markHelp(
  tx: QueryExecutor,
  turnId: string,
  hint: { index: number; text: string; usedAt: string; usedBy: string } | null,
  actorId: string,
  userId: string,
) {
  await tx.query(
    'UPDATE engine_turns SET assistant_help=true,admin_assistance=admin_assistance OR $2 WHERE id=$1',
    [turnId, actorId !== userId],
  );
  if (hint)
    await tx.query('UPDATE engine_turns SET used_hints=used_hints || $2::jsonb WHERE id=$1', [
      turnId,
      JSON.stringify([hint]),
    ]);
}
