import { randomUUID, randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { meetingSchema, roomStateSchema, joinMeetingSchema } from '@luch/contracts';
import { learningFixture, failOn, type Login } from './helpers/learning.js';
import { MeetingsService } from '../src/modules/meetings/service.js';
import {
  LiveKitVideo,
  type MeetingVideo,
  type RtcPeer,
  type MediaPolicy,
} from '../src/modules/meetings/adapter.js';
import { classifyDevice } from '../src/modules/meetings/devices.js';
import { parseSettings } from '../src/config.js';
class Video implements MeetingVideo {
  configured = true;
  browserUrl = 'ws://127.0.0.1:7880';
  peers: RtcPeer[] = [];
  calls: { kind: string; identity?: string; policy?: MediaPolicy }[] = [];
  fail = false;
  async ensureRoom() {
    if (this.fail) throw Error('planned outage');
  }
  async participants() {
    if (this.fail) throw Error('planned outage');
    return this.peers;
  }
  async permissions(_r: string, identity: string, policy: MediaPolicy) {
    if (this.fail) throw Error('planned outage');
    this.calls.push({ kind: 'permissions', identity, policy });
  }
  async remove(_r: string, identity: string) {
    if (this.fail) throw Error('planned outage');
    this.calls.push({ kind: 'remove', identity });
    this.peers = this.peers.filter((p) => p.identity !== identity);
  }
  async close() {
    if (this.fail) throw Error('planned outage');
    this.calls.push({ kind: 'close' });
    this.peers = [];
  }
  async token(_r: string, identity: string, _n: string, policy: MediaPolicy) {
    if (this.fail) throw Error('planned outage');
    this.calls.push({ kind: 'token', identity, policy });
    return 'fixture-token';
  }
}
let f: Awaited<ReturnType<typeof learningFixture>>;
const video = new Video();
beforeAll(async () => {
  f = await learningFixture(undefined, video);
});
beforeEach(async () => {
  await f.reset();
  video.calls = [];
  video.peers = [];
  video.fail = false;
  video.configured = true;
});
afterAll(async () => {
  await f.app.close();
});
async function group() {
  const teacher = await f.active('teacher'),
    student = await f.active(),
    peer = await f.active();
  for (const s of [student, peer])
    await f.db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
      teacher.actor.user.id,
      s.actor.user.id,
    ]);
  return { teacher, student, peer };
}
function draft(teacher: Login, students: Login[], fields: Record<string, unknown> = {}) {
  return {
    operationId: randomUUID(),
    title: 'Занятие по языку',
    description: 'Практика общения',
    language: 'ru',
    startsAt: new Date(Date.now() - 60000).toISOString(),
    endsAt: new Date(Date.now() + 3600000).toISOString(),
    timeZone: 'Europe/Moscow',
    organizerId: teacher.actor.user.id,
    coorganizerIds: [],
    studentIds: students.map((s) => s.actor.user.id),
    lobbyEnabled: true,
    ...fields,
  };
}
async function post(user: Login, url: string, body: unknown, status = 200) {
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: user.headers,
    payload: body,
  });
  expect(r.statusCode, r.body).toBe(status);
  return r.json().data;
}
async function create(teacher: Login, students: Login[], fields: Record<string, unknown> = {}) {
  return meetingSchema.parse(await post(teacher, '/meetings', draft(teacher, students, fields)));
}
async function join(user: Login, id: string, op = randomUUID()) {
  return joinMeetingSchema.parse(await post(user, `/meetings/${id}/join`, { operationId: op }));
}
async function mod(
  user: Login,
  id: string,
  action: string,
  fields: Record<string, unknown> = {},
  status = 200,
) {
  return post(
    user,
    `/meetings/${id}/moderate`,
    { operationId: randomUUID(), action, ...fields },
    status,
  );
}
async function room(user: Login, id: string, sid?: string) {
  const r = await f.app.inject({
    url: `/api/v1/meetings/${id}/room-state${sid ? `?sessionId=${sid}` : ''}`,
    headers: user.headers,
  });
  expect(r.statusCode, r.body).toBe(200);
  return roomStateSchema.parse(r.json().data);
}
async function count(table: string) {
  return Number(
    (await f.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n,
  );
}
async function entered() {
  const g = await group(),
    m = await create(g.teacher, [g.student, g.peer]);
  const t = await join(g.teacher, m.id),
    s = await join(g.student, m.id);
  await mod(g.teacher, m.id, 'admit', { targetId: s.session.id });
  video.peers = [
    { identity: t.session.id, tracks: [] },
    { identity: s.session.id, tracks: [] },
  ];
  return { ...g, m, t, s };
}
describe('meeting scheduler and open-source conferencing integration', () => {
  it.each([1, 2])(
    'creates a saved calendar with %s students, optimistic revisions and repeat-safe creation',
    async (n) => {
      const g = await group(),
        input = draft(g.teacher, [g.student, g.peer].slice(0, n));
      const m = meetingSchema.parse(await post(g.teacher, '/meetings', input));
      expect((await post(g.teacher, '/meetings', input)).id).toBe(m.id);
      expect(await count('scheduled_meetings')).toBe(1);
      const q = new URLSearchParams({
        from: new Date(Date.now() - 86400000).toISOString(),
        to: new Date(Date.now() + 86400000).toISOString(),
      });
      for (const u of [g.teacher, g.student]) {
        const r = await f.app.inject({ url: `/api/v1/meetings?${q}`, headers: u.headers });
        expect(r.json().data.items[0].id).toBe(m.id);
      }
      await post(g.teacher, `/meetings/${m.id}`, {
        ...input,
        operationId: randomUUID(),
        revision: 1,
        title: 'Новый срок',
      });
      await post(
        g.teacher,
        `/meetings/${m.id}`,
        { ...input, operationId: randomUUID(), revision: 1, title: 'Устаревший срок' },
        409,
      );
      await post(g.teacher, '/meetings', { ...input, title: 'Другой запрос' }, 409);
    },
  );
  it('rejects foreign students, invalid intervals, duplicate members, unknown zones and CSRF', async () => {
    const g = await group(),
      stranger = await f.active();
    await post(g.teacher, '/meetings', draft(g.teacher, [stranger]), 403);
    await post(g.student, '/meetings', draft(g.teacher, [g.student]), 403);
    for (const fields of [
      { timeZone: 'Unknown/Zone' },
      { endsAt: new Date(0).toISOString() },
      { studentIds: [g.student.actor.user.id, g.student.actor.user.id] },
      { coorganizerIds: [g.teacher.actor.user.id] },
    ])
      await post(g.teacher, '/meetings', draft(g.teacher, [g.student], fields), 400);
    const r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/meetings',
      headers: { cookie: g.teacher.headers.cookie },
      payload: draft(g.teacher, [g.student]),
    });
    expect(r.statusCode).toBe(403);
    expect(await count('scheduled_meetings')).toBe(0);
  });
  it('admits through the lobby and never issues an attendee room-admin grant', async () => {
    const g = await group(),
      m = await create(g.teacher, [g.student]),
      op = randomUUID();
    const s = await join(g.student, m.id, op);
    expect(s.session.state).toBe('waiting');
    expect((await join(g.student, m.id, op)).session.id).toBe(s.session.id);
    await post(g.student, `/meetings/${m.id}/sessions/${s.session.id}/token`, {}, 409);
    await join(g.teacher, m.id);
    await post(g.student, `/meetings/${m.id}/sessions/${s.session.id}/token`, {}, 403);
    await mod(g.teacher, m.id, 'admit', { targetId: s.session.id });
    expect(
      (await post(g.student, `/meetings/${m.id}/sessions/${s.session.id}/token`, {})).identity,
    ).toBe(s.session.id);
    expect(await count('meeting_sessions')).toBe(2);
    const settings = parseSettings({
      APP_ENV: 'test',
      LIVEKIT_URL: 'http://127.0.0.1:7880',
      LIVEKIT_WS_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_API_KEY: 'fixture_key',
      LIVEKIT_API_SECRET: randomBytes(32).toString('hex'),
    });
    const token = await new LiveKitVideo(settings).token('room', s.session.id, 'Student', {
      audioAllowed: false,
      videoAllowed: true,
      screenAllowed: false,
    });
    const grant = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).video;
    expect(grant.roomAdmin).toBe(false);
    expect(grant.canPublishData).toBe(false);
    expect(grant.canUpdateOwnMetadata).toBe(false);
    expect(grant.canPublishSources).toEqual(['camera']);
  });
  it('holds an uninvited student out; root and administrator can enter visibly', async () => {
    const g = await group(),
      m = await create(g.teacher, [g.student]),
      stranger = await f.active(),
      root = await f.active('superadmin'),
      admin = await f.active('admin');
    await post(stranger, `/meetings/${m.id}/join`, { operationId: randomUUID() }, 404);
    const r = await join(root, m.id),
      a = await join(admin, m.id);
    video.peers = [
      { identity: r.session.id, tracks: [] },
      { identity: a.session.id, tracks: [] },
    ];
    const state = await room(root, m.id);
    expect(state.participants.map((p) => p.role).sort()).toEqual(['admin', 'superadmin']);
    expect((await room(admin, m.id)).meeting.canInspect).toBe(false);
  });
  it('persists audio/video/screen restrictions and grants permission without forcing capture', async () => {
    const g = await entered();
    for (const action of ['mute_audio', 'disable_video', 'stop_screen'])
      await mod(g.teacher, g.m.id, action, { targetId: g.s.session.id });
    let state = await room(g.student, g.m.id, g.s.session.id);
    expect(state.self).toMatchObject({
      audioAllowed: false,
      videoAllowed: false,
      screenAllowed: false,
    });
    expect(video.calls.filter((c) => c.kind === 'permissions').at(-1)!.policy).toEqual({
      audioAllowed: false,
      videoAllowed: false,
      screenAllowed: false,
    });
    await mod(g.teacher, g.m.id, 'allow_audio', { targetId: g.s.session.id });
    state = await room(g.student, g.m.id, g.s.session.id);
    expect(state.self!.audioAllowed).toBe(true);
    expect(state.self!.videoAllowed).toBe(false);
    expect(video.calls.some((c) => c.kind === 'unmute')).toBe(false);
    await mod(g.student, g.m.id, 'kick', { targetId: g.t.session.id }, 403);
  });
  it('kicks, revokes the old identity, blocks rejoin, and explicitly restores with a new session', async () => {
    const g = await entered();
    await mod(g.teacher, g.m.id, 'kick', { targetId: g.s.session.id });
    expect((await room(g.student, g.m.id, g.s.session.id)).self!.state).toBe('removed');
    expect(video.calls.some((c) => c.kind === 'remove' && c.identity === g.s.session.id)).toBe(
      true,
    );
    await post(g.student, `/meetings/${g.m.id}/join`, { operationId: randomUUID() }, 403);
    await post(g.student, `/meetings/${g.m.id}/sessions/${g.s.session.id}/token`, {}, 403);
    await mod(g.teacher, g.m.id, 'restore', { targetId: g.student.actor.user.id });
    const again = await join(g.student, g.m.id);
    expect(again.session.id).not.toBe(g.s.session.id);
    expect(again.session.state).toBe('waiting');
  });
  it('private active-device warnings are visible only to organizers and root, never peers or global admins', async () => {
    const g = await entered(),
      peer = await join(g.peer, g.m.id),
      root = await f.active('superadmin'),
      admin = await f.active('admin');
    await mod(g.teacher, g.m.id, 'admit', { targetId: peer.session.id });
    video.peers.find((p) => p.identity === g.s.session.id)!.tracks = [
      { sid: 'TR_cam', source: 'camera', muted: false },
      { sid: 'TR_mic', source: 'microphone', muted: false },
      { sid: 'TR_screen', source: 'screen', muted: false },
    ];
    const report = {
      revision: 1,
      camera: { label: 'OBS Virtual Camera', trackSid: 'TR_cam' },
      microphone: { label: 'Microphone (NVIDIA Broadcast)', trackSid: 'TR_mic' },
    };
    await post(g.student, `/meetings/${g.m.id}/sessions/${g.s.session.id}/devices`, report);
    for (const inspector of [g.teacher, root]) {
      const state = await room(inspector, g.m.id);
      expect(
        state.participants
          .find((p) => p.identity === g.s.session.id)!
          .warnings.map((w) => w.kind)
          .sort(),
      ).toEqual(['camera', 'microphone']);
    }
    for (const hidden of [g.student, g.peer, admin]) {
      const state = await room(hidden, g.m.id);
      expect(JSON.stringify(state)).not.toContain('OBS Virtual Camera');
      expect(
        state.participants.every((p) => p.warnings.length === 0 && p.deviceReportedAt === null),
      ).toBe(true);
    }
    await post(g.peer, `/meetings/${g.m.id}/sessions/${g.s.session.id}/devices`, report, 404);
    await post(
      g.student,
      `/meetings/${g.m.id}/sessions/${g.s.session.id}/devices`,
      { ...report, camera: { label: 'changed', trackSid: 'TR_cam' } },
      409,
    );
  });
  it('clears warnings on muted/replaced tracks, accepts only real camera/microphone sources, and ignores stale reports', async () => {
    const g = await entered(),
      deviceUrl = `/meetings/${g.m.id}/sessions/${g.s.session.id}/devices`;
    video.peers.find((p) => p.identity === g.s.session.id)!.tracks = [
      { sid: 'TR_cam', source: 'camera', muted: false },
      { sid: 'TR_screen', source: 'screen', muted: false },
    ];
    await post(g.student, deviceUrl, {
      revision: 2,
      camera: { label: 'OBS Virtual Camera', trackSid: 'TR_cam' },
      microphone: { label: 'VB-Audio', trackSid: 'TR_screen' },
    });
    let state = await room(g.teacher, g.m.id);
    expect(state.participants.find((p) => p.identity === g.s.session.id)!.warnings).toHaveLength(1);
    video.peers.find((p) => p.identity === g.s.session.id)!.tracks[0]!.muted = true;
    state = await room(g.teacher, g.m.id);
    expect(state.participants.find((p) => p.identity === g.s.session.id)!.warnings).toHaveLength(0);
    await post(g.student, deviceUrl, { revision: 3, camera: null, microphone: null });
    await post(g.student, deviceUrl, {
      revision: 1,
      camera: { label: 'OBS Virtual Camera', trackSid: 'TR_cam' },
      microphone: null,
    });
    const stored = (
      await f.db.query('SELECT * FROM meeting_device_reports WHERE session_id=$1', [g.s.session.id])
    ).rows[0]!;
    expect(stored.revision).toBe(3);
    expect(stored.camera).toBeNull();
    expect(await count('engine_attempts')).toBe(0);
  });
  it('saves hands, chat, lock/end and rejects early joins without learning penalties', async () => {
    const g = await entered();
    await post(g.student, `/meetings/${g.m.id}/sessions/${g.s.session.id}/hand`, { raised: true });
    expect(
      (await room(g.teacher, g.m.id)).participants.find((p) => p.identity === g.s.session.id)!
        .handRaisedAt,
    ).not.toBeNull();
    await mod(g.teacher, g.m.id, 'lower_hand', { targetId: g.s.session.id });
    const message = { operationId: randomUUID(), text: 'Вопрос по уроку' };
    await post(g.student, `/meetings/${g.m.id}/messages`, message);
    await post(g.student, `/meetings/${g.m.id}/messages`, message);
    expect(await count('meeting_messages')).toBe(1);
    const locked = await mod(g.teacher, g.m.id, 'lock', { revision: 2 });
    await post(g.peer, `/meetings/${g.m.id}/join`, { operationId: randomUUID() }, 409);
    const ended = await mod(g.teacher, g.m.id, 'end', { revision: locked.revision });
    expect(ended.status).toBe('completed');
    expect(video.calls.some((c) => c.kind === 'close')).toBe(true);
    await post(g.student, `/meetings/${g.m.id}/sessions/${g.s.session.id}/token`, {}, 409);
    expect(await count('engine_attempts')).toBe(0);
    const future = await create(g.teacher, [g.student], {
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      endsAt: new Date(Date.now() + 90000000).toISOString(),
    });
    await post(g.student, `/meetings/${future.id}/join`, { operationId: randomUUID() }, 409);
  });
  it('delivers saved moderation after a technical outage and never claims a failed command was applied', async () => {
    const g = await entered();
    let now = Date.now();
    const service = new MeetingsService(f.db, video, () => now);
    video.fail = true;
    await service.moderate(g.teacher.actor, g.m.id, {
      operationId: randomUUID(),
      action: 'mute_audio',
      targetId: g.s.session.id,
    });
    expect((await service.room(g.teacher.actor, g.m.id)).pendingCommands).toBe(1);
    expect((await f.db.query('SELECT status FROM meeting_commands')).rows[0]!.status).toBe(
      'pending',
    );
    video.fail = false;
    now += 6000;
    await service.recover();
    expect((await service.room(g.teacher.actor, g.m.id)).pendingCommands).toBe(0);
    expect(video.calls.find((c) => c.kind === 'permissions')!.policy!.audioAllowed).toBe(false);
  });
  it.each(['ru', 'en'] as const)(
    'saves a %s lesson summary and actual plan homework atomically, resumes through existing engine',
    async (language) => {
      const g = await group(),
        p = await f.preparedPlan(g.student, { language }),
        m = await create(g.teacher, [g.student], { language });
      await join(g.teacher, m.id);
      await mod(g.teacher, m.id, 'end', { revision: 2 });
      const input = {
        operationId: randomUUID(),
        revision: 0,
        comment: 'Повторите материал перед следующей встречей.',
        homework: [
          {
            studentId: g.student.actor.user.id,
            planId: p.plan.id,
            exerciseId: language === 'ru' ? 'rki-02-practice-text' : 'english-02-practice-text',
            reason: 'Закрепляем тему занятия.',
            dueAt: null,
          },
        ],
      };
      const saved = meetingSchema.parse(await post(g.teacher, `/meetings/${m.id}/summary`, input));
      await post(g.teacher, `/meetings/${m.id}/summary`, input);
      expect(saved.homework).toHaveLength(1);
      expect(await count('meeting_homework')).toBe(1);
      const assignment = (await f.plan(g.student, p.plan.id)).assignments.find(
        (a) => a.id === saved.homework[0]!.assignmentId,
      )!;
      expect(assignment.kind).toBe('teacher');
      expect(assignment.reason.text).toContain('Домашнее задание после');
      const run = await f.start(g.student, p.plan.id, assignment.id);
      expect(run.current!.exercise.id).toBe(input.homework[0]!.exerciseId);
      const studentView = await new MeetingsService(f.db, video).read(g.student.actor, m.id);
      expect(studentView.summaryComment).toBe(input.comment);
      expect(studentView.homework).toHaveLength(1);
      await post(
        g.teacher,
        `/meetings/${m.id}/summary`,
        { ...input, operationId: randomUUID() },
        409,
      );
    },
  );
  it('rolls back the summary, linked homework and teacher action when any participant has an invalid plan', async () => {
    const g = await group(),
      p = await f.preparedPlan(g.student),
      m = await create(g.teacher, [g.student, g.peer]);
    await join(g.teacher, m.id);
    await mod(g.teacher, m.id, 'end', { revision: 2 });
    await post(
      g.teacher,
      `/meetings/${m.id}/summary`,
      {
        operationId: randomUUID(),
        revision: 0,
        comment: 'Не сохранять частично.',
        homework: [
          {
            studentId: g.student.actor.user.id,
            planId: p.plan.id,
            exerciseId: 'rki-02-practice-text',
            reason: 'Практика.',
            dueAt: null,
          },
          {
            studentId: g.peer.actor.user.id,
            planId: p.plan.id,
            exerciseId: 'rki-02-practice-text',
            reason: 'Чужой план.',
            dueAt: null,
          },
        ],
      },
      400,
    );
    expect(await count('meeting_homework')).toBe(0);
    expect(await count('teacher_actions')).toBe(0);
    expect(
      (await new MeetingsService(f.db, video).read(g.student.actor, m.id)).summaryComment,
    ).toBeNull();
  });
  it('preserves current teacher access checks for homework after unlinking', async () => {
    const g = await group(),
      p = await f.preparedPlan(g.student),
      m = await create(g.teacher, [g.student]);
    await join(g.teacher, m.id);
    await mod(g.teacher, m.id, 'end', { revision: 2 });
    await f.db.query('DELETE FROM teacher_students WHERE teacher_id=$1', [g.teacher.actor.user.id]);
    await post(
      g.teacher,
      `/meetings/${m.id}/summary`,
      {
        operationId: randomUUID(),
        revision: 0,
        comment: 'Комментарий',
        homework: [
          {
            studentId: g.student.actor.user.id,
            planId: p.plan.id,
            exerciseId: 'rki-02-practice-text',
            reason: 'Практика.',
            dueAt: null,
          },
        ],
      },
      404,
    );
    expect(await count('meeting_homework')).toBe(0);
  });
  it('serializes duplicate join/moderation and prevents starting an already cancelled meeting', async () => {
    const g = await group(),
      m = await create(g.teacher, [g.student]),
      op = randomUUID();
    const sessions = await Promise.all([join(g.student, m.id, op), join(g.student, m.id, op)]);
    expect(sessions[0]!.session.id).toBe(sessions[1]!.session.id);
    await mod(g.teacher, m.id, 'cancel', { revision: 1 });
    await post(g.teacher, `/meetings/${m.id}/join`, { operationId: randomUUID() }, 409);
    expect(await count('meeting_sessions')).toBe(1);
  });
  it('recognizes separately maintained camera/microphone names without flagging ordinary hardware', () => {
    for (const name of [
      'OBS Virtual Camera',
      'Camera (NVIDIA Broadcast)',
      'ManyCam Virtual Webcam',
      'XSplit VCam',
      'SplitCam Video Driver',
      'NDI Webcam Video',
      'v4l2loopback',
    ])
      expect(classifyDevice('camera', name), name).not.toBeNull();
    for (const name of [
      'CABLE Output (VB-Audio Virtual Cable)',
      'Voicemeeter Output',
      'BlackHole 2ch',
      'Loopback Audio',
      'Microphone (NVIDIA Broadcast)',
      'NVIDIA RTX Voice',
      'ManyCam Virtual Microphone',
      'Voice.ai Audio Cable',
      'Voicemod Virtual Audio Device',
    ])
      expect(classifyDevice('microphone', name), name).not.toBeNull();
    for (const name of ['Logitech BRIO', 'FaceTime HD Camera', 'Integrated Camera', 'USB Camera'])
      expect(classifyDevice('camera', name)).toBeNull();
    for (const name of [
      'Microphone (Realtek Audio)',
      'USB Audio Device',
      'AirPods Pro',
      'Built-in Microphone',
      '',
    ])
      expect(classifyDevice('microphone', name)).toBeNull();
    expect(classifyDevice('microphone', 'OBS Studio')).toBeNull();
  });
});

describe('meeting recovery boundaries', () => {
  it('keeps a scheduled meeting unchanged when the SFU fails before the host enters', async () => {
    const g = await group(),
      m = await create(g.teacher, [g.student]);
    video.fail = true;
    await post(g.teacher, `/meetings/${m.id}/join`, { operationId: randomUUID() }, 503);
    expect(await count('meeting_sessions')).toBe(0);
    expect((await new MeetingsService(f.db, video).read(g.teacher.actor, m.id)).status).toBe(
      'scheduled',
    );
    expect(await count('engine_attempts')).toBe(0);
  });
  it('reuses an admitted session after a reload while entrance is locked', async () => {
    const g = await entered();
    await mod(g.teacher, g.m.id, 'lock', { revision: 2 });
    const service = new MeetingsService(f.db, video);
    expect((await service.read(g.student.actor, g.m.id)).canJoin).toBe(true);
    const reconnect = await join(g.student, g.m.id);
    expect(reconnect.session.id).toBe(g.s.session.id);
    await post(g.student, `/meetings/${g.m.id}/sessions/${g.s.session.id}/token`, {});
    expect(await count('meeting_sessions')).toBe(2);
  });
  it('does not expose the live roster to a waiting attendee without a session parameter', async () => {
    const g = await entered();
    const wait = await join(g.peer, g.m.id);
    expect(wait.session.state).toBe('waiting');
    expect((await room(g.peer, g.m.id)).participants).toHaveLength(0);
    expect((await room(g.teacher, g.m.id)).participants).toHaveLength(2);
  });
  it('restores the device sequence for a reloaded client and classifies a changed active device immediately', async () => {
    const g = await entered();
    const peer = video.peers.find((p) => p.identity === g.s.session.id)!;
    peer.tracks = [{ sid: 'camera', source: 'camera', muted: false }];
    const path = `/meetings/${g.m.id}/sessions/${g.s.session.id}/devices`;
    await post(g.student, path, {
      revision: 50,
      camera: { label: 'OBS Virtual Camera', trackSid: 'camera' },
      microphone: null,
    });
    const current = await room(g.student, g.m.id, g.s.session.id);
    expect(current.self!.deviceRevision).toBe(50);
    await post(g.student, path, {
      revision: current.self!.deviceRevision + 1,
      camera: { label: 'Logitech BRIO', trackSid: 'camera' },
      microphone: null,
    });
    expect(
      (await room(g.teacher, g.m.id)).participants.find((p) => p.identity === g.s.session.id)!
        .warnings,
    ).toHaveLength(0);
  });
});
