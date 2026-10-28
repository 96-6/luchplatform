import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  meetingSchema,
  meetingInviteSchema,
  meetingMessagesSchema,
  roomStateSchema,
} from '@luch/contracts';
import { learningFixture, failOn, type Login } from './helpers/learning.js';
import { MeetingsService } from '../src/modules/meetings/service.js';
import { MeetingFiles } from '../src/modules/meetings/files.js';
import {
  LiveKitVideo,
  type MeetingVideo,
  type MediaPolicy,
  type RtcPeer,
} from '../src/modules/meetings/adapter.js';
let f: Awaited<ReturnType<typeof learningFixture>>, directory: string, files: MeetingFiles;
const MB = 1024 * 1024;
class Video implements MeetingVideo {
  configured = true;
  browserUrl = '/api/v1/video';
  peers: RtcPeer[] = [];
  removed: string[] = [];
  async ensureRoom() {}
  async participants() {
    return this.peers;
  }
  async permissions(_room: string, _id: string, _policy: MediaPolicy) {}
  async remove(_room: string, id: string) {
    this.removed.push(id);
    this.peers = this.peers.filter((p) => p.identity !== id);
  }
  async close() {
    this.peers = [];
  }
  async token(room: string, id: string, name: string, p: MediaPolicy) {
    return new LiveKitVideo(f.settings).token(room, id, name, p);
  }
}
const video = new Video();
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'luch-meeting-extensions-'));
  const web = join(directory, 'web');
  await mkdir(web);
  await writeFile(join(web, 'index.html'), '<!doctype html><title>Meeting fixture</title>');
  f = await learningFixture(
    undefined,
    video,
    {
      LIVEKIT_URL: 'http://127.0.0.1:7880',
      LIVEKIT_WS_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: 'meeting_guest_fixture',
      LIVEKIT_API_SECRET: randomBytes(32).toString('hex'),
    },
    web,
    join(directory, 'files'),
  );
  files = new MeetingFiles(f.db, join(directory, 'files'));
});
beforeEach(async () => {
  await f.reset();
  await rm(join(directory, 'files'), { recursive: true, force: true });
  video.peers = [];
  video.removed = [];
});
afterAll(async () => {
  await f.app.close();
  await rm(directory, { recursive: true, force: true });
});
type Headers = { cookie: string; 'x-meeting-csrf'?: string; 'x-csrf-token'?: string };
async function post(headers: Headers, url: string, payload: unknown, status = 200) {
  const r = await f.app.inject({ method: 'POST', url: '/api/v1' + url, headers, payload });
  expect(r.statusCode, r.body).toBe(status);
  return r;
}
async function create(teacher: Login, extra: Record<string, unknown> = {}) {
  const input = {
    operationId: randomUUID(),
    title: 'Внеплановое обсуждение',
    language: 'ru',
    timeZone: 'Europe/Moscow',
    durationMinutes: null,
    reusable: true,
    allowGuests: true,
    lobbyEnabled: true,
    expiresAt: null,
    ...extra,
  };
  const r = await post(teacher.headers, '/meetings/adhoc', input);
  const result = r.json().data;
  meetingSchema.parse(result.meeting);
  meetingInviteSchema.parse(result.invite);
  return { ...result, input, token: new URL(result.invite.url).searchParams.get('token')! };
}
async function redeem(
  token: string,
  name = 'Гость',
  headers: Headers = { cookie: '' },
  operationId = randomUUID(),
  status = 200,
) {
  const r = await post(
    headers,
    '/meeting-invites/redeem',
    { token, ...(name ? { name } : {}), operationId },
    status,
  );
  if (status !== 200) return { response: r, headers, data: null };
  const data = r.json().data;
  const cookie = r.cookies.find((c) => c.name.includes('luch_guest_'));
  return {
    response: r,
    data,
    headers: cookie
      ? { cookie: `${cookie.name}=${cookie.value}`, 'x-meeting-csrf': data.guest.csrfToken }
      : headers,
  };
}
async function enter(headers: Headers, id: string, status = 200) {
  return (await post(headers, `/meetings/${id}/join`, { operationId: randomUUID() }, status)).json()
    .data;
}
async function moderate(
  teacher: Login,
  id: string,
  action: string,
  fields: Record<string, unknown> = {},
) {
  return (
    await post(teacher.headers, `/meetings/${id}/moderate`, {
      operationId: randomUUID(),
      action,
      ...fields,
    })
  ).json().data;
}
async function active(teacher: Login, extra: Record<string, unknown> = {}) {
  const m = await create(teacher, extra);
  await enter(teacher.headers, m.meeting.id);
  return m;
}
async function policy(root: Login, max = 2, threshold = 1, days = 10) {
  const p = (
    await f.app.inject({ url: '/api/v1/admin/meeting-file-policy', headers: root.headers })
  ).json().data;
  return post(root.headers, '/admin/meeting-file-policy', {
    maxFileMb: max,
    largeFileMb: threshold,
    retentionDays: days,
    revision: p.revision,
  });
}
it('applies the recording policy to guest rooms and forbids guest policy changes', async () => {
  const root = await f.active('superadmin'),
    teacher = await f.active('teacher');
  const created = await create(teacher);
  const guest = await redeem(created.token, 'Гость с защитой');
  const before = await f.app.inject({
    url: `/api/v1/meetings/${created.meeting.id}`,
    headers: guest.headers,
  });
  expect(before.json().data.recordingProtectionEnabled).toBe(false);
  await post(root.headers, '/admin/meeting-recording-policy', { enabled: true, revision: 1 });
  const joined = await enter(guest.headers, created.meeting.id);
  expect(joined.meeting.recordingProtectionEnabled).toBe(true);
  const live = await f.app.inject({
    url: `/api/v1/meetings/${created.meeting.id}/room-state?sessionId=${joined.session.id}`,
    headers: guest.headers,
  });
  expect(live.statusCode, live.body).toBe(200);
  expect(roomStateSchema.parse(live.json().data).meeting.recordingProtectionEnabled).toBe(true);
  const endpoint = '/api/v1/admin/meeting-recording-policy';
  expect((await f.app.inject({ url: endpoint, headers: guest.headers })).statusCode).toBe(401);
  await post(
    guest.headers,
    '/admin/meeting-recording-policy',
    { enabled: false, revision: 2 },
    401,
  );
});
async function upload(
  headers: Headers,
  id: string,
  data: Buffer,
  name = 'lesson.bin',
  operationId = randomUUID(),
  status = 200,
) {
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/v1/meetings/${id}/files/${operationId}`,
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
    },
    payload: data,
  });
  expect(r.statusCode, r.body).toBe(status);
  return r.json().data;
}
async function send(
  headers: Headers,
  id: string,
  text: string,
  attachmentIds: string[] = [],
  op = randomUUID(),
  status = 200,
) {
  return (
    await post(
      headers,
      `/meetings/${id}/messages`,
      { operationId: op, text, attachmentIds },
      status,
    )
  ).json().data;
}

describe('ad hoc meeting invitations and scoped guests', () => {
  it('creates a separate meeting with no student assignment and stable idempotent invitation', async () => {
    const teacher = await f.active('teacher'),
      student = await f.active();
    expect(
      (
        await post(
          student.headers,
          '/meetings/adhoc',
          {
            operationId: randomUUID(),
            title: 'Forbidden',
            language: 'ru',
            timeZone: 'UTC',
            durationMinutes: null,
            reusable: true,
            allowGuests: true,
            expiresAt: null,
          },
          403,
        )
      ).statusCode,
    ).toBe(403);
    const m = await create(teacher);
    expect(m.meeting.kind).toBe('adhoc');
    expect(m.meeting.endsAt).toBeNull();
    expect(m.meeting.members).toHaveLength(1);
    const again = (await post(teacher.headers, '/meetings/adhoc', m.input)).json().data;
    expect(again).toEqual({ meeting: m.meeting, invite: m.invite });
    await post(teacher.headers, '/meetings/adhoc', { ...m.input, title: 'Changed' }, 409);
    const secret = (
      await f.db.query<{ token_hash: string; token_ciphertext: string }>(
        'SELECT * FROM meeting_invites',
      )
    ).rows[0]!;
    expect(JSON.stringify(secret)).not.toContain(m.token);
    const own = await f.app.inject({
      url: `/api/v1/meetings/${m.meeting.id}`,
      headers: student.headers,
    });
    expect(own.statusCode).toBe(404);
  });
  it('binds a one-use invitation atomically to one guest and safely replays the original operation', async () => {
    const teacher = await f.active('teacher'),
      m = await create(teacher, { reusable: false }),
      before = (await f.db.query('SELECT id FROM users')).rows.length;
    const op = randomUUID(),
      secondOp = randomUUID();
    const results = await Promise.all([
      f.app.inject({
        method: 'POST',
        url: '/api/v1/meeting-invites/redeem',
        payload: { token: m.token, name: 'Первый', operationId: op },
      }),
      f.app.inject({
        method: 'POST',
        url: '/api/v1/meeting-invites/redeem',
        payload: { token: m.token, name: 'Второй', operationId: secondOp },
      }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 410]);
    const guests = (
      await f.db.query<{ id: string; full_name: string; join_operation_id: string }>(
        'SELECT * FROM meeting_guests',
      )
    ).rows;
    expect(guests).toHaveLength(1);
    expect((await f.db.query('SELECT id FROM users')).rows).toHaveLength(before);
    const winner = guests[0]!,
      replay = await redeem(m.token, winner.full_name, { cookie: '' }, winner.join_operation_id);
    expect(replay.data.guest.id).toBe(winner.id);
    await redeem(m.token, 'Не владелец', { cookie: '' }, randomUUID(), 410);
    expect((await f.db.query('SELECT * FROM auth_sessions')).rows).toHaveLength(1);
    await post(
      teacher.headers,
      `/meetings/${m.meeting.id}/invite/restart`,
      { operationId: randomUUID() },
      409,
    );
  });
  it('allows one authenticated recipient to return but grants no learning access to the organizer', async () => {
    const teacher = await f.active('teacher'),
      student = await f.active(),
      other = await f.active(),
      m = await create(teacher, { reusable: false, allowGuests: false });
    await redeem(m.token, '', teacher.headers);
    expect(
      (await f.db.query('SELECT used_by_user_id FROM meeting_invites WHERE id=$1', [m.invite.id]))
        .rows[0].used_by_user_id,
    ).toBeNull();
    await redeem(m.token, '', student.headers);
    await redeem(m.token, '', student.headers);
    await redeem(m.token, '', other.headers, randomUUID(), 410);
    await redeem(m.token, '', teacher.headers);
    expect((await f.db.query('SELECT * FROM teacher_students')).rows).toHaveLength(0);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/users/${student.actor.user.id}`,
          headers: teacher.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
  it('keeps guests out of ordinary accounts, chat and media until admission', async () => {
    const teacher = await f.active('teacher'),
      m = await create(teacher),
      g = await redeem(m.token, 'Гость <script>');
    expect(g.response.cookies.every((c) => !c.name.endsWith('luch_session'))).toBe(true);
    expect(
      (await f.app.inject({ url: '/api/v1/auth/session', headers: g.headers })).json().data.user,
    ).toBeNull();
    for (const path of [
      '/api/v1/admin/accounts',
      '/api/v1/teacher/students',
      '/api/v1/learning/profile',
      '/api/v1/operations',
    ])
      expect((await f.app.inject({ url: path, headers: g.headers })).statusCode).toBe(401);
    const joined = await enter(g.headers, m.meeting.id);
    expect(joined.session.state).toBe('waiting');
    await enter(teacher.headers, m.meeting.id);
    await post(g.headers, `/meetings/${m.meeting.id}/sessions/${joined.session.id}/token`, {}, 403);
    expect(
      (await f.app.inject({ url: `/api/v1/meetings/${m.meeting.id}/messages`, headers: g.headers }))
        .statusCode,
    ).toBe(403);
    await enter(teacher.headers, m.meeting.id);
    await moderate(teacher, m.meeting.id, 'admit', { targetId: joined.session.id });
    const ticket = (
      await post(g.headers, `/meetings/${m.meeting.id}/sessions/${joined.session.id}/token`, {})
    ).json().data;
    expect(
      (
        await f.app.inject({
          url: `/api/v1/video/rtc/validate?access_token=${ticket.token}`,
          headers: g.headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.app.inject({ url: `/api/v1/video/rtc/validate?access_token=${ticket.token}` }))
        .statusCode,
    ).toBe(401);
    await send(g.headers, m.meeting.id, 'Сообщение гостя');
    const read = await f.app.inject({
      url: `/api/v1/meetings/${m.meeting.id}/messages`,
      headers: teacher.headers,
    });
    expect(read.body).toContain('Сообщение гостя');
    expect(
      (await f.app.inject({ url: '/api/v1/auth/session', headers: g.headers })).json().data.user,
    ).toBeNull();
  });
  it('supports guest moderation, current signalling policy and readmission with a new connection', async () => {
    const teacher = await f.active('teacher'),
      m = await active(teacher, { lobbyEnabled: false }),
      g = await redeem(m.token),
      j = await enter(g.headers, m.meeting.id);
    const ticket = (
      await post(g.headers, `/meetings/${m.meeting.id}/sessions/${j.session.id}/token`, {})
    ).json().data;
    await moderate(teacher, m.meeting.id, 'mute_audio', { targetId: j.session.id });
    const room = roomStateSchema.parse(
      (
        await f.app.inject({
          url: `/api/v1/meetings/${m.meeting.id}/room-state`,
          headers: g.headers,
        })
      ).json().data,
    );
    expect(room.self!.audioAllowed).toBe(false);
    await moderate(teacher, m.meeting.id, 'kick', { targetId: j.session.id });
    expect(
      (
        await f.app.inject({
          url: `/api/v1/video/rtc/validate?access_token=${ticket.token}`,
          headers: g.headers,
        })
      ).statusCode,
    ).toBe(403);
    await enter(g.headers, m.meeting.id, 403);
    await moderate(teacher, m.meeting.id, 'restore', { targetId: g.data.guest.id });
    const next = await enter(g.headers, m.meeting.id);
    expect(next.session.id).not.toBe(j.session.id);
  });
  it('admits early waiting guests automatically when the organizer starts with the lobby disabled', async () => {
    const teacher = await f.active('teacher'),
      m = await create(teacher, { lobbyEnabled: false }),
      g = await redeem(m.token),
      j = await enter(g.headers, m.meeting.id);
    expect(j.session.state).toBe('waiting');
    await enter(teacher.headers, m.meeting.id);
    const state = (
      await f.app.inject({ url: `/api/v1/meetings/${m.meeting.id}/room-state`, headers: g.headers })
    ).json().data;
    expect(state.self.state).toBe('admitted');
    await send(g.headers, m.meeting.id, 'Без зала ожидания');
  });
  it('requires guest CSRF and rejects forged sessions and unrelated meeting access', async () => {
    const teacher = await f.active('teacher'),
      m = await active(teacher, { lobbyEnabled: false }),
      other = await create(teacher),
      g = await redeem(m.token);
    await enter({ cookie: g.headers.cookie }, m.meeting.id, 403);
    await enter({ ...g.headers, 'x-meeting-csrf': 'forged' }, m.meeting.id, 403);
    expect(
      (await f.app.inject({ url: `/api/v1/meetings/${other.meeting.id}`, headers: g.headers }))
        .statusCode,
    ).toBe(401);
    expect(
      (await f.app.inject({ url: `/guest/meetings/${m.meeting.id}/room`, headers: g.headers }))
        .statusCode,
    ).toBe(200);
    expect((await f.app.inject({ url: `/guest/meetings/${m.meeting.id}/room` })).statusCode).toBe(
      401,
    );
  });
  it('expires and revokes invitations and immediately removes existing guests when access is disabled', async () => {
    const teacher = await f.active('teacher'),
      m = await active(teacher, { lobbyEnabled: false }),
      g = await redeem(m.token),
      j = await enter(g.headers, m.meeting.id);
    expect((await f.app.inject({ url: `/meeting-invite?token=${m.token}` })).statusCode).toBe(200);
    await f.db.query(
      "UPDATE meeting_invites SET expires_at=now()-interval '1 second' WHERE id=$1",
      [m.invite.id],
    );
    expect((await f.app.inject({ url: `/meeting-invite?token=${m.token}` })).statusCode).toBe(410);
    await redeem(m.token, 'new', { cookie: '' }, randomUUID(), 410);
    const changed = (
      await post(teacher.headers, `/meetings/${m.meeting.id}/invite`, {
        operationId: randomUUID(),
        revision: 1,
        allowGuests: false,
        revoked: false,
        expiresAt: null,
      })
    ).json().data;
    expect(changed.allowGuests).toBe(false);
    expect(video.removed).toContain(j.session.id);
    expect(
      (await f.app.inject({ url: `/api/v1/meetings/${m.meeting.id}`, headers: g.headers }))
        .statusCode,
    ).toBe(401);
    await redeem(m.token, 'new', { cookie: '' }, randomUUID(), 401);
    await post(
      teacher.headers,
      `/meetings/${m.meeting.id}/invite`,
      {
        operationId: randomUUID(),
        revision: 1,
        allowGuests: true,
        revoked: false,
        expiresAt: null,
      },
      409,
    );
  });
  it('reuses the same URL for a new meeting while retaining old chat and access boundaries', async () => {
    const teacher = await f.active('teacher'),
      m = await active(teacher, { lobbyEnabled: false }),
      g = await redeem(m.token);
    await enter(g.headers, m.meeting.id);
    await send(g.headers, m.meeting.id, 'История первой встречи');
    const current = (
      await f.app.inject({ url: `/api/v1/meetings/${m.meeting.id}`, headers: teacher.headers })
    ).json().data;
    await moderate(teacher, m.meeting.id, 'end', { revision: current.revision });
    const op = randomUUID(),
      next = (
        await post(teacher.headers, `/meetings/${m.meeting.id}/invite/restart`, { operationId: op })
      ).json().data;
    expect(next.invite.url).toBe(m.invite.url);
    expect(next.meeting.id).not.toBe(m.meeting.id);
    const again = (
      await post(teacher.headers, `/meetings/${m.meeting.id}/invite/restart`, { operationId: op })
    ).json().data;
    expect(again.meeting.id).toBe(next.meeting.id);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/meetings/${next.meeting.id}/messages`,
          headers: g.headers,
        })
      ).statusCode,
    ).toBe(401);
    const old = await f.app.inject({
      url: `/api/v1/meetings/${m.meeting.id}/messages`,
      headers: teacher.headers,
    });
    expect(old.body).toContain('История первой встречи');
    const fresh = await redeem(m.token, 'Следующий гость');
    expect(fresh.data.meetingId).toBe(next.meeting.id);
  });
  it('enforces the configured duration and keeps unlimited meetings open beyond the scheduled grace period', async () => {
    const teacher = await f.active('teacher'),
      limited = await active(teacher, { durationMinutes: 1, lobbyEnabled: false }),
      unlimited = await active(teacher, { durationMinutes: null });
    await f.db.query(
      "UPDATE scheduled_meetings SET starts_at=now()-interval '1 hour',ends_at=now()-interval '1 second' WHERE id=$1",
      [limited.meeting.id],
    );
    await post(
      teacher.headers,
      `/meetings/${limited.meeting.id}/sessions/${(await f.db.query<{ id: string }>('SELECT id FROM meeting_sessions WHERE meeting_id=$1', [limited.meeting.id])).rows[0]!.id}/token`,
      {},
      409,
    );
    const svc = new MeetingsService(f.db, video);
    await svc.recover();
    expect(
      (
        await f.db.query<{ status: string }>('SELECT status FROM scheduled_meetings WHERE id=$1', [
          limited.meeting.id,
        ])
      ).rows[0]!.status,
    ).toBe('completed');
    await f.db.query(
      "UPDATE scheduled_meetings SET starts_at=now()-interval '7 days' WHERE id=$1",
      [unlimited.meeting.id],
    );
    await svc.recover();
    expect(
      (
        await f.db.query<{ status: string }>('SELECT status FROM scheduled_meetings WHERE id=$1', [
          unlimited.meeting.id,
        ])
      ).rows[0]!.status,
    ).toBe('live');
  });
});

describe('meeting files and configurable retention', () => {
  it('provides the requested defaults and restricts settings to superadmins with CSRF and revision checks', async () => {
    const root = await f.active('superadmin'),
      teacher = await f.active('teacher');
    const current = await f.app.inject({
      url: '/api/v1/admin/meeting-file-policy',
      headers: root.headers,
    });
    expect(current.json().data).toEqual({
      maxFileMb: 125,
      largeFileMb: 50,
      retentionDays: 10,
      revision: 1,
    });
    expect(
      (await f.app.inject({ url: '/api/v1/admin/meeting-file-policy', headers: teacher.headers }))
        .statusCode,
    ).toBe(403);
    await post(
      { cookie: root.headers.cookie },
      '/admin/meeting-file-policy',
      { ...current.json().data, maxFileMb: 100 },
      403,
    );
    await policy(root, 2, 1, 10);
    await post(
      root.headers,
      '/admin/meeting-file-policy',
      { ...current.json().data, maxFileMb: 100 },
      409,
    );
    await post(
      root.headers,
      '/admin/meeting-file-policy',
      { maxFileMb: 1, largeFileMb: 2, retentionDays: 10, revision: 2 },
      400,
    );
  });
  it('persists text, image previews and ordinary attachments and rejects unauthorized reads', async () => {
    const teacher = await f.active('teacher'),
      outsider = await f.active(),
      m = await active(teacher, { lobbyEnabled: false }),
      g = await redeem(m.token);
    await enter(g.headers, m.meeting.id);
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6pAAAAABJRU5ErkJggg==',
      'base64',
    );
    const image = await upload(g.headers, m.meeting.id, png, 'фото.png'),
      file = await upload(
        teacher.headers,
        m.meeting.id,
        Buffer.from('Материал занятия'),
        'учебный файл.txt',
      );
    expect(image.mediaType).toBe('image/png');
    expect(file.mediaType).toBe('application/octet-stream');
    const messages = await send(g.headers, m.meeting.id, 'Посмотрите картинку', [image.id]);
    meetingMessagesSchema.parse(messages);
    await send(teacher.headers, m.meeting.id, '', [file.id]);
    const read = await f.app.inject({ url: image.url, headers: teacher.headers });
    expect(read.statusCode).toBe(200);
    expect(read.rawPayload).toEqual(png);
    expect(read.headers['content-type']).toContain('image/png');
    expect(
      (await f.app.inject({ url: file.url, headers: g.headers })).headers['content-disposition'],
    ).toMatch(/^attachment/);
    expect((await f.app.inject({ url: image.url })).statusCode).toBe(401);
    expect((await f.app.inject({ url: image.url, headers: outsider.headers })).statusCode).toBe(
      404,
    );
    await send(g.headers, m.meeting.id, 'Чужой файл', [file.id], randomUUID(), 403);
  });
  it('enforces actual byte size, inclusive maximum and the configured retention threshold', async () => {
    const teacher = await f.active('teacher'),
      root = await f.active('superadmin'),
      m = await active(teacher);
    await policy(root, 2, 1, 10);
    const wrongFormat = await f.app.inject({
      method: 'POST',
      url: `/api/v1/meetings/${m.meeting.id}/files/${randomUUID()}`,
      headers: {
        ...teacher.headers,
        'content-type': 'application/json',
        'x-file-name': 'not-a-stream.json',
      },
      payload: { body: 'Reject before buffering a large JSON document' },
    });
    expect(wrongFormat.statusCode).toBe(415);
    expect(wrongFormat.json().error.code).toBe('MEETING_FILE_FORMAT');
    const exact = await upload(teacher.headers, m.meeting.id, Buffer.alloc(2 * MB), 'limit.bin');
    expect(exact.sizeBytes).toBe(2 * MB);
    await upload(
      teacher.headers,
      m.meeting.id,
      Buffer.alloc(2 * MB + 1),
      'too-large.bin',
      randomUUID(),
      413,
    );
    await expect(
      files.upload(
        teacher.actor,
        m.meeting.id,
        randomUUID(),
        'lying.bin',
        Readable.from([Buffer.alloc(2 * MB + 1)]),
        1,
      ),
    ).rejects.toMatchObject({ code: 'MEETING_FILE_TOO_LARGE' });
    const threshold = await upload(
      teacher.headers,
      m.meeting.id,
      Buffer.alloc(MB),
      'threshold.bin',
    );
    expect(threshold.expiresAt).toBeNull();
    const big = await upload(teacher.headers, m.meeting.id, Buffer.alloc(MB + 1), 'big.bin');
    expect(Date.parse(big.expiresAt) - Date.now()).toBeGreaterThan(10 * 86400000 - 10000);
  });
  it('makes upload and send retries idempotent and preserves the original file on conflicting content', async () => {
    const teacher = await f.active('teacher'),
      m = await active(teacher),
      op = randomUUID(),
      data = Buffer.from('original');
    const first = await upload(teacher.headers, m.meeting.id, data, 'file.txt', op),
      again = await upload(teacher.headers, m.meeting.id, data, 'file.txt', op);
    expect(again).toEqual(first);
    await upload(teacher.headers, m.meeting.id, Buffer.from('modified'), 'file.txt', op, 409);
    const msgOp = randomUUID();
    await send(teacher.headers, m.meeting.id, '', [first.id], msgOp);
    await send(teacher.headers, m.meeting.id, '', [first.id], msgOp);
    expect((await f.db.query('SELECT * FROM meeting_messages')).rows).toHaveLength(1);
    expect(await readdir(join(directory, 'files'))).toHaveLength(1);
  });
  it('does not publish unadmitted, foreign, expired or executable image content', async () => {
    const teacher = await f.active('teacher'),
      m = await active(teacher),
      g = await redeem(m.token);
    await enter(g.headers, m.meeting.id);
    await upload(g.headers, m.meeting.id, Buffer.from('waiting'), 'waiting.txt', randomUUID(), 403);
    const fake = await upload(
      teacher.headers,
      m.meeting.id,
      Buffer.from('<svg onload="alert(1)"></svg>'),
      'picture.svg',
    );
    expect(fake.mediaType).toBe('application/octet-stream');
    await send(teacher.headers, m.meeting.id, '', [fake.id]);
    const read = await f.app.inject({ url: fake.url, headers: teacher.headers });
    expect(read.headers['content-disposition']).toMatch(/^attachment/);
    expect(read.headers['x-content-type-options']).toBe('nosniff');
    const id = randomUUID();
    await upload(teacher.headers, m.meeting.id, Buffer.from('path'), '../escape', id, 400);
  });
  it('denies expired files immediately, deletes their bytes and leaves the message history intact', async () => {
    const teacher = await f.active('teacher'),
      root = await f.active('superadmin'),
      m = await active(teacher);
    await policy(root, 2, 1, 10);
    const small = await upload(teacher.headers, m.meeting.id, Buffer.alloc(MB), 'small.bin'),
      large = await upload(teacher.headers, m.meeting.id, Buffer.alloc(MB + 1), 'large.bin');
    await send(teacher.headers, m.meeting.id, 'Материал', [small.id, large.id]);
    await f.db.query("UPDATE meeting_files SET expires_at=now()-interval '1 second' WHERE id=$1", [
      large.id,
    ]);
    expect((await f.app.inject({ url: large.url, headers: teacher.headers })).statusCode).toBe(410);
    expect(await files.cleanup()).toBe(1);
    await expect(stat(join(directory, 'files', large.id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await f.app.inject({ url: small.url, headers: teacher.headers })).statusCode).toBe(200);
    const rows = (
      await f.app.inject({
        url: `/api/v1/meetings/${m.meeting.id}/messages`,
        headers: teacher.headers,
      })
    ).json().data;
    expect(rows.items).toHaveLength(1);
    expect(rows.items[0].attachments.find((x: { id: string }) => x.id === large.id).deleted).toBe(
      true,
    );
  });
  it('does not lose committed file bytes after an uncertain database acknowledgment', async () => {
    const teacher = await f.active('teacher'),
      m = await active(teacher),
      operationId = randomUUID();
    const uncertain = new MeetingFiles(
      {
        ...f.db,
        transaction: async (work) => {
          await f.db.transaction(work);
          throw Error('Lost commit acknowledgment');
        },
      },
      join(directory, 'files'),
    );
    await expect(
      uncertain.upload(
        teacher.actor,
        m.meeting.id,
        operationId,
        'commit.txt',
        Readable.from([Buffer.from('saved')]),
        5,
      ),
    ).rejects.toThrow('Lost commit acknowledgment');
    const retry = await files.upload(
      teacher.actor,
      m.meeting.id,
      operationId,
      'commit.txt',
      Readable.from([Buffer.from('saved')]),
      5,
    );
    expect(await readdir(join(directory, 'files'))).toEqual([retry.id]);
    const failed = new MeetingFiles(
      failOn(f.db, 'INSERT INTO meeting_files'),
      join(directory, 'files'),
    );
    await expect(
      failed.upload(
        teacher.actor,
        m.meeting.id,
        randomUUID(),
        'failed.txt',
        Readable.from([Buffer.from('failed')]),
        6,
      ),
    ).rejects.toThrow();
    expect(await readdir(join(directory, 'files'))).toEqual([retry.id]);
  });
});
