import { randomUUID, createHash } from 'node:crypto';
import { mkdir, unlink, stat, readdir } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { z } from 'zod';
import { meetingFilePolicySchema } from '@luch/contracts';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { Actor } from '../auth/service.js';
import { audit } from '../accounts/repository.js';
import { access, iso, deadline } from './repository.js';
import { isGuest, type MeetingActor } from './identity.js';
export const MAX_MEETING_FILE_BYTES = 1024 * 1024 * 1024;
const MB = 1024 * 1024,
  DAY = 86400000;
export type MeetingFileRow = {
  id: string;
  meeting_id: string;
  owner_user_id: string | null;
  owner_guest_id: string | null;
  operation_id: string;
  message_id: string | null;
  filename: string;
  media_type: string;
  size_bytes: number | string;
  content_hash: string;
  storage_key: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  deleted_at: Date | string | null;
  purged_at: Date | string | null;
};
export const fileDto = (f: MeetingFileRow, now = Date.now()) => ({
  id: f.id,
  filename: f.filename,
  mediaType: f.media_type,
  sizeBytes: Number(f.size_bytes),
  expiresAt: iso(f.expires_at),
  deleted:
    Boolean(f.deleted_at) || (f.expires_at !== null && new Date(f.expires_at).getTime() <= now),
  url: `/api/v1/meetings/${f.meeting_id}/files/${f.id}`,
});
export async function fileAccess(
  tx: QueryExecutor,
  actor: MeetingActor,
  id: string,
  write = false,
  now = Date.now(),
) {
  const a = await access(tx, actor, id, write);
  if (a.member?.blocked_at)
    throw new AppError(403, 'MEETING_REMOVED', 'Доступ к чату закрыт организатором.');
  if (isGuest(actor) && !a.member?.admitted_at)
    throw new AppError(403, 'MEETING_NOT_ADMITTED', 'Дождитесь допуска организатора.');
  if (write) {
    if (a.m.status !== 'live' || now > deadline(a.m))
      throw new AppError(409, 'MEETING_CLOSED', 'Занятие завершено или отменено.');
    const active = (
      await tx.query<{ vanish: boolean }>(
        "SELECT vanish FROM meeting_sessions WHERE meeting_id=$1 AND COALESCE(user_id,guest_id)=$2 AND state='admitted'",
        [id, actor.user.id],
      )
    ).rows[0];
    if (!active)
      throw new AppError(403, 'MEETING_NOT_ADMITTED', 'Сначала присоединитесь к встрече.');
    if (active.vanish)
      throw new AppError(
        403,
        'MEETING_VANISH_READ_ONLY',
        'В VANISH-режиме доступны просмотр и прослушивание.',
      );
  }
  return a;
}
const imageType = (b: Buffer) =>
  b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? 'image/png'
    : b[0] === 255 && b[1] === 216 && b[2] === 255
      ? 'image/jpeg'
      : ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii'))
        ? 'image/gif'
        : b.subarray(0, 4).toString('ascii') === 'RIFF' &&
            b.subarray(8, 12).toString('ascii') === 'WEBP'
          ? 'image/webp'
          : 'application/octet-stream';
export class MeetingFiles {
  readonly directory: string;
  constructor(
    readonly db: Database,
    directory: string,
    readonly now: () => number = Date.now,
  ) {
    this.directory = resolve(directory);
  }
  async policy(tx: QueryExecutor = this.db) {
    const p = (
      await tx.query<{
        max_file_mb: number;
        large_file_mb: number;
        retention_days: number;
        revision: number;
      }>('SELECT * FROM meeting_file_policy WHERE id=1')
    ).rows[0];
    return p
      ? {
          maxFileMb: p.max_file_mb,
          largeFileMb: p.large_file_mb,
          retentionDays: p.retention_days,
          revision: p.revision,
        }
      : { maxFileMb: 125, largeFileMb: 50, retentionDays: 10, revision: 1 };
  }
  async updatePolicy(actor: Actor, input: z.infer<typeof meetingFilePolicySchema>) {
    if (actor.user.role !== 'superadmin')
      throw new AppError(403, 'ACCESS_DENIED', 'Доступ запрещён.');
    return this.db.transaction(async (tx) => {
      await tx.query('INSERT INTO meeting_file_policy(id) VALUES(1) ON CONFLICT DO NOTHING');
      const r = await tx.query(
        'UPDATE meeting_file_policy SET max_file_mb=$1,large_file_mb=$2,retention_days=$3,revision=revision+1,updated_at=$4,updated_by=$5 WHERE id=1 AND revision=$6 RETURNING id',
        [
          input.maxFileMb,
          input.largeFileMb,
          input.retentionDays,
          new Date(this.now()),
          actor.user.id,
          input.revision,
        ],
      );
      if (!r.rows.length)
        throw new AppError(409, 'SETTINGS_CHANGED', 'Настройки уже изменены. Обновите страницу.');
      await audit(tx, actor.user.id, 'meeting.file_policy_changed');
      return this.policy(tx);
    });
  }
  private expired(f: MeetingFileRow) {
    return (
      Boolean(f.deleted_at) ||
      (f.expires_at !== null && new Date(f.expires_at).getTime() <= this.now()) ||
      (f.message_id === null && new Date(f.created_at).getTime() + DAY <= this.now())
    );
  }
  private path(key: string) {
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error('Invalid private file key');
    return join(this.directory, key);
  }
  async upload(
    actor: MeetingActor,
    id: string,
    operationId: string,
    filename: string,
    body: Readable,
    length?: number,
  ) {
    if (!filename.trim() || filename.length > 200 || /[\x00-\x1f\x7f/\\]/.test(filename))
      throw new AppError(400, 'MEETING_FILE_NAME', 'Некорректное имя файла.');
    await fileAccess(this.db, actor, id, true, this.now());
    const p = await this.policy(),
      limit = p.maxFileMb * MB;
    if (length !== undefined && (!Number.isFinite(length) || length < 1 || length > limit))
      throw new AppError(413, 'MEETING_FILE_TOO_LARGE', 'Файл превышает разрешённый размер.');
    const key = randomUUID(),
      path = this.path(key);
    await mkdir(this.directory, { recursive: true });
    let size = 0,
      head = Buffer.alloc(0),
      saved = false;
    const hash = createHash('sha256');
    const count = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > limit) {
          callback(
            new AppError(413, 'MEETING_FILE_TOO_LARGE', 'Файл превышает разрешённый размер.'),
          );
          return;
        }
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(body, count, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
      if (size === 0 || (length !== undefined && length !== size))
        throw new AppError(
          400,
          'MEETING_FILE_INCOMPLETE',
          'Файл передан не полностью. Повторите загрузку.',
        );
      const digest = hash.digest('hex'),
        media = imageType(head);
      const file = await this.db.transaction(async (tx) => {
        if (this.db.kind === 'postgres')
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            `meeting-file:${actor.user.id}:${operationId}`,
          ]);
        await fileAccess(tx, actor, id, true, this.now());
        const current = await this.policy(tx);
        if (size > current.maxFileMb * MB)
          throw new AppError(413, 'MEETING_FILE_TOO_LARGE', 'Файл превышает разрешённый размер.');
        const old = (
          await tx.query<MeetingFileRow>(
            `SELECT * FROM meeting_files WHERE ${isGuest(actor) ? 'owner_guest_id' : 'owner_user_id'}=$1 AND operation_id=$2 FOR UPDATE`,
            [actor.user.id, operationId],
          )
        ).rows[0];
        if (old) {
          if (
            old.meeting_id !== id ||
            old.filename !== filename ||
            Number(old.size_bytes) !== size ||
            old.content_hash !== digest
          )
            throw new AppError(
              409,
              'MEETING_OPERATION_CONFLICT',
              'Загрузка уже сохранена с другим файлом.',
            );
          if (this.expired(old))
            throw new AppError(410, 'MEETING_FILE_EXPIRED', 'Срок хранения файла истёк.');
          return old;
        }
        const f = (
          await tx.query<MeetingFileRow>(
            'INSERT INTO meeting_files(id,meeting_id,owner_user_id,owner_guest_id,operation_id,filename,media_type,size_bytes,content_hash,storage_key,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$1,$10,$11) RETURNING *',
            [
              key,
              id,
              isGuest(actor) ? null : actor.user.id,
              isGuest(actor) ? actor.user.id : null,
              operationId,
              filename,
              media,
              size,
              digest,
              new Date(this.now()),
              size > current.largeFileMb * MB
                ? new Date(this.now() + current.retentionDays * DAY)
                : null,
            ],
          )
        ).rows[0]!;
        return f;
      });
      saved = file.storage_key === key;
      return fileDto(file, this.now());
    } finally {
      if (!saved) {
        try {
          if (
            !(await this.db.query('SELECT 1 FROM meeting_files WHERE storage_key=$1', [key])).rows
              .length
          )
            await unlink(path).catch(() => {});
        } catch {
          /* A later sweep resolves an uncertain commit without deleting a committed file. */
        }
      }
    }
  }
  async download(actor: MeetingActor, id: string, fileId: string) {
    await fileAccess(this.db, actor, id);
    const f = (
      await this.db.query<MeetingFileRow>(
        'SELECT * FROM meeting_files WHERE id=$1 AND meeting_id=$2',
        [fileId, id],
      )
    ).rows[0];
    if (
      !f ||
      (!f.message_id && (isGuest(actor) ? f.owner_guest_id : f.owner_user_id) !== actor.user.id)
    )
      throw new AppError(404, 'MEETING_FILE_NOT_FOUND', 'Файл не найден.');
    if (this.expired(f))
      throw new AppError(410, 'MEETING_FILE_EXPIRED', 'Срок хранения файла истёк.');
    try {
      await stat(this.path(f.storage_key));
    } catch {
      throw new AppError(
        503,
        'MEETING_FILE_UNAVAILABLE',
        'Файл временно недоступен. Повторите попытку.',
      );
    }
    return { file: f, stream: createReadStream(this.path(f.storage_key)) };
  }
  async cleanup() {
    const now = new Date(this.now());
    await this.db.query(
      'UPDATE meeting_files SET deleted_at=$1 WHERE deleted_at IS NULL AND ((expires_at IS NOT NULL AND expires_at<=$1) OR (message_id IS NULL AND created_at<=$2))',
      [now, new Date(this.now() - DAY)],
    );
    const rows = (
      await this.db.query<MeetingFileRow>(
        'SELECT * FROM meeting_files WHERE deleted_at IS NOT NULL AND purged_at IS NULL ORDER BY created_at,id LIMIT 100',
      )
    ).rows;
    let removed = 0;
    for (const f of rows) {
      try {
        await unlink(this.path(f.storage_key));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') continue;
      }
      await this.db.query('UPDATE meeting_files SET purged_at=$2 WHERE id=$1', [f.id, now]);
      removed++;
    }
    let entries: string[] = [];
    try {
      entries = await readdir(this.directory);
    } catch {
      /* No uploaded files yet. */
    }
    for (const key of entries.slice(0, 1000)) {
      if (!/^[0-9a-f-]{36}$/.test(key)) continue;
      try {
        const info = await stat(this.path(key));
        if (info.mtimeMs + DAY > this.now()) continue;
        if (
          !(await this.db.query('SELECT 1 FROM meeting_files WHERE storage_key=$1', [key])).rows
            .length
        )
          await unlink(this.path(key));
      } catch {
        /* Retry on next sweep. */
      }
    }
    return removed;
  }
  async forMessages(tx: QueryExecutor, messageIds: string[]) {
    const rows = messageIds.length
      ? (
          await tx.query<MeetingFileRow>(
            'SELECT * FROM meeting_files WHERE message_id=ANY($1::uuid[]) ORDER BY created_at,id',
            [messageIds],
          )
        ).rows
      : [];
    return (messageId: string) =>
      rows.filter((f) => f.message_id === messageId).map((f) => fileDto(f, this.now()));
  }
  async attach(
    tx: QueryExecutor,
    actor: MeetingActor,
    id: string,
    messageId: string,
    ids: string[],
  ) {
    if (new Set(ids).size !== ids.length)
      throw new AppError(400, 'MEETING_FILE_DUPLICATE', 'Файл повторяется.');
    for (const fid of [...ids].sort()) {
      const f = (
        await tx.query<MeetingFileRow>('SELECT * FROM meeting_files WHERE id=$1 FOR UPDATE', [fid])
      ).rows[0];
      if (
        !f ||
        f.meeting_id !== id ||
        (isGuest(actor) ? f.owner_guest_id : f.owner_user_id) !== actor.user.id ||
        f.message_id
      )
        throw new AppError(
          403,
          'MEETING_FILE_ACCESS',
          'Выберите собственный загруженный файл этой встречи.',
        );
      if (this.expired(f))
        throw new AppError(410, 'MEETING_FILE_EXPIRED', 'Срок хранения файла истёк.');
      await tx.query('UPDATE meeting_files SET message_id=$2 WHERE id=$1', [fid, messageId]);
    }
  }
}
