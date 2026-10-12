import { randomUUID } from 'node:crypto';
import type { CreateProbe, Probe } from '@luch/contracts';
import type { Database } from '../../db/database.js';
import { AppError } from '../../errors.js';

type ProbeRow = { id: string; operation_id: string; label: string; created_at: Date | string };
function toProbe(row: ProbeRow): Probe {
  return {
    id: row.id,
    label: row.label,
    operationId: row.operation_id,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
export async function listProbes(database: Database): Promise<Probe[]> {
  const result = await database.query<ProbeRow>(
    'SELECT id, operation_id, label, created_at FROM system_probes ORDER BY created_at DESC, id DESC LIMIT 20',
  );
  return result.rows.map(toProbe);
}
export async function saveProbe(
  database: Database,
  input: CreateProbe,
): Promise<{ record: Probe; created: boolean }> {
  const result = await database.query<ProbeRow>(
    `INSERT INTO system_probes (id, operation_id, label) VALUES ($1, $2, $3)
     ON CONFLICT (operation_id) DO NOTHING RETURNING id, operation_id, label, created_at`,
    [randomUUID(), input.operationId, input.label],
  );
  if (result.rows[0]) return { record: toProbe(result.rows[0]), created: true };
  const previous = await database.query<ProbeRow>(
    'SELECT id, operation_id, label, created_at FROM system_probes WHERE operation_id = $1',
    [input.operationId],
  );
  const row = previous.rows[0];
  if (!row)
    throw new AppError(
      503,
      'DATABASE_UNAVAILABLE',
      'Не удалось сохранить запись. Повторите попытку.',
    );
  if (row.label !== input.label)
    throw new AppError(
      409,
      'OPERATION_CONFLICT',
      'Идентификатор операции уже использован для другой записи.',
    );
  return { record: toProbe(row), created: false };
}
