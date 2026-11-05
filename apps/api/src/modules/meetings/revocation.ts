import type { QueryExecutor } from '../../db/database.js';
import { command } from './repository.js';

export async function removeMeetingSessions(tx: QueryExecutor, ids: string[], now = Date.now()) {
  if (!ids.length) return;
  const rows = (
    await tx.query<{ id: string; meeting_id: string }>(
      "UPDATE meeting_sessions SET state='removed',hand_raised_at=NULL,ended_at=$2 WHERE id=ANY($1::uuid[]) AND state IN ('waiting','admitted') RETURNING id,meeting_id",
      [ids, new Date(now)],
    )
  ).rows;
  for (const s of rows) {
    await command(tx, s.meeting_id, 'remove', { identity: s.id }, now);
    await tx.query('DELETE FROM meeting_device_reports WHERE session_id=$1', [s.id]);
  }
}
export async function revokeUserMeetingSessions(
  tx: QueryExecutor,
  userId: string,
  now = Date.now(),
) {
  const rows = (
    await tx.query<{ id: string }>(
      "SELECT id FROM meeting_sessions WHERE user_id=$1 AND state IN ('waiting','admitted') ORDER BY id",
      [userId],
    )
  ).rows;
  await removeMeetingSessions(
    tx,
    rows.map((s) => s.id),
    now,
  );
}
