import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat, link, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { updateJobSchema, type UpdateJob } from '@luch/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthService } from '../auth/service.js';

export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export async function readSmallJson(path: string) {
  if ((await stat(path)).size > 3 * 1024 * 1024) throw Error('State file too large');
  const content = await readFile(path, 'utf8');
  if (content.length > 3 * 1024 * 1024) throw Error('State file too large');
  return JSON.parse(content) as unknown;
}
export async function atomicJson(path: string, value: unknown) {
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(temp, path);
}
const agentFile = z.object({
  protocol: z.literal(1),
  mode: z.enum(['node', 'container']),
  heartbeatAt: z.iso.datetime(),
});
export class UpdateSpool {
  constructor(
    readonly directory: string,
    readonly now = Date.now,
  ) {}
  async agent() {
    if (this.directory)
      try {
        const value = agentFile.parse(await readSmallJson(resolve(this.directory, 'agent.json')));
        const age = this.now() - Date.parse(value.heartbeatAt);
        return { ...value, available: age >= -5000 && age < 20000 };
      } catch {}
    return { available: false, mode: null, heartbeatAt: null, protocol: null };
  }
  async job(id: string): Promise<UpdateJob | null> {
    if (!this.directory || !z.uuid().safeParse(id).success) return null;
    try {
      return updateJobSchema.parse(
        await readSmallJson(resolve(this.directory, 'jobs', id + '.json')),
      );
    } catch {
      return null;
    }
  }
  async enqueue(job: UpdateJob) {
    await mkdir(resolve(this.directory, 'jobs'), { recursive: true, mode: 0o700 });
    const path = resolve(this.directory, 'jobs', job.id + '.json'),
      temp = path + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(job) + '\n', { mode: 0o600 });
    try {
      await link(temp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      await unlink(temp);
    }
  }
  async grant(auth: AuthService, request: FastifyRequest, reply: FastifyReply, id: string) {
    const session = request.cookies[auth.sessionCookie];
    if (!session) return;
    const name =
      auth.settings.APP_ENV === 'production'
        ? '__Secure-luch_update_progress'
        : 'luch_update_progress';
    const previous = request.cookies[name];
    if (previous && /^[A-Za-z0-9_-]{43}$/.test(previous))
      try {
        const old = z
          .object({ jobId: z.uuid(), sessionHash: z.string(), expiresAt: z.number() })
          .parse(
            await readSmallJson(resolve(this.directory, 'grants', digest(previous) + '.json')),
          );
        if (
          old.jobId === id &&
          old.sessionHash === digest(session) &&
          old.expiresAt > this.now() + 300000
        )
          return;
      } catch {}
    const secret = randomBytes(32).toString('base64url');
    await mkdir(resolve(this.directory, 'grants'), { recursive: true, mode: 0o700 });
    await atomicJson(resolve(this.directory, 'grants', digest(secret) + '.json'), {
      jobId: id,
      sessionHash: digest(session),
      expiresAt: this.now() + 60 * 60 * 1000,
    });
    reply.setCookie(name, secret, {
      path: '/api/v1/admin/updates',
      httpOnly: true,
      secure: auth.settings.APP_ENV === 'production',
      sameSite: 'strict',
      maxAge: 3600,
    });
  }
}
