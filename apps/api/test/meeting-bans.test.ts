import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { meetingIpBanSchema, meetingIpBansPageSchema, MEETING_BAN_HOLD_MS } from '@luch/contracts';
import { learningFixture, type Login } from './helpers/learning.js';
import { MeetingsService } from '../src/modules/meetings/service.js';
import type { MeetingVideo, RtcPeer, MediaPolicy } from '../src/modules/meetings/adapter.js';
class Video implements MeetingVideo {
  configured = true;
  browserUrl = '/api/v1/video';
  peers: RtcPeer[] = [];
  removed: string[] = [];
  fail = false;
  async ensureRoom() {}
  async participants() {
    return this.peers;
  }
  async permissions(_r: string, _s: string, _p: MediaPolicy) {}
  async remove(_r: string, id: string) {
    if (this.fail) throw Error('SFU outage');
    this.removed.push(id);
    this.peers = this.peers.filter((p) => p.identity !== id);
  }
  async close() {}
  async token() {
    return 'fixture-token';
  }
}
const video = new Video();
let f: Awaited<ReturnType<typeof learningFixture>>;
type Headers = {
  cookie: string;
  'x-csrf-token'?: string;
  'x-meeting-csrf'?: string;
  'x-forwarded-for'?: string;
};
beforeAll(async () => {
  f = await learningFixture(undefined, video);
});
beforeEach(async () => {
  await f.reset();
  video.peers = [];
  video.removed = [];
  video.fail = false;
});
afterAll(async () => {
  await f.app.close();
});
async function post(
  path: string,
  headers: Headers,
  payload: unknown,
  status = 200,
  ip = '192.0.2.10',
) {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/v1' + path,
    headers,
    payload,
    remoteAddress: ip,
  });
  expect(r.statusCode, r.body).toBe(status);
  return r;
}
async function meeting() {
  const owner = await f.active('teacher');
  const data = (
    await post('/meetings/adhoc', owner.headers, {
      operationId: randomUUID(),
      title: 'Guest ban fixture',
      language: 'ru',
      timeZone: 'Europe/Moscow',
      durationMinutes: null,
      reusable: true,
      allowGuests: true,
      expiresAt: null,
      lobbyEnabled: false,
    })
  ).json().data;
  await post(`/meetings/${data.meeting.id}/join`, owner.headers, { operationId: randomUUID() });
  return {
    owner,
    id: data.meeting.id as string,
    token: new URL(data.invite.url).searchParams.get('token')!,
    invite: data.invite,
  };
}
async function guest(
  m: Awaited<ReturnType<typeof meeting>>,
  ip = '192.0.2.50',
  name = 'Guest',
  headers: Headers = { cookie: '' },
) {
  const r = await post(
      '/meeting-invites/redeem',
      headers,
      { token: m.token, name, operationId: randomUUID() },
      200,
      ip,
    ),
    data = r.json().data;
  const cookie = r.cookies.find((c) => c.name.includes('luch_guest_'))!;
  const h = { cookie: `${cookie.name}=${cookie.value}`, 'x-meeting-csrf': data.guest.csrfToken };
  const joined = (
    await post(`/meetings/${m.id}/join`, h, { operationId: randomUUID() }, 200, ip)
  ).json().data;
  video.peers.push({ identity: joined.session.id, tracks: [] });
  return { headers: h, sessionId: joined.session.id as string, id: data.guest.id as string, ip };
}
async function prepare(m: Awaited<ReturnType<typeof meeting>>, sessionId: string) {
  return (
    await post(`/meetings/${m.id}/ip-bans/prepare`, m.owner.headers, {
      operationId: randomUUID(),
      sessionId,
      reason: 'Leaked invitation',
    })
  ).json().data;
}
async function mature(id: string) {
  await f.db.query(
    "UPDATE meeting_ban_confirmations SET ready_at=now()-interval '1 second' WHERE id=$1",
    [id],
  );
}
async function confirm(actor: Login, id: string, status = 200) {
  return post('/meeting-ip-bans/confirm', actor.headers, { confirmationId: id }, status);
}
async function ban(m: Awaited<ReturnType<typeof meeting>>, g: Awaited<ReturnType<typeof guest>>) {
  const c = await prepare(m, g.sessionId);
  await mature(c.id);
  return meetingIpBanSchema.parse((await confirm(m.owner, c.id)).json().data);
}
describe('account and guest IP call revocation', () => {
  it.each([true, false])(
    'removes ordinary live sessions transactionally on account ban/deactivation (ban=%s)',
    async (blocked) => {
      const m = await meeting(),
        root = await f.active('superadmin'),
        student = await f.active();
      await post('/meeting-invites/redeem', student.headers, {
        operationId: randomUUID(),
        token: m.token,
      });
      const joined = (
        await post(`/meetings/${m.id}/join`, student.headers, { operationId: randomUUID() })
      ).json().data;
      video.peers.push({ identity: joined.session.id, tracks: [] });
      await post(`/admin/accounts/${student.actor.user.id}`, root.headers, {
        isBlocked: blocked,
        isActive: blocked,
        accessVerified: true,
        blockReason: 'Audit test',
      });
      expect(
        (await f.db.query('SELECT state FROM meeting_sessions WHERE id=$1', [joined.session.id]))
          .rows[0]?.state,
      ).toBe('removed');
      expect(video.removed).toContain(joined.session.id);
      await post(`/meetings/${m.id}/sessions/${joined.session.id}/token`, student.headers, {}, 401);
      await new MeetingsService(f.db, video).recover();
      expect(video.removed.filter((id) => id === joined.session.id)).toHaveLength(1);
    },
  );
  it('recovers missed ordinary account revocations and retries saved SFU removal after an outage', async () => {
    const m = await meeting();
    await f.db.query('UPDATE users SET is_blocked=true WHERE id=$1', [m.owner.actor.user.id]);
    const sid = (
      await f.db.query<{ id: string }>(
        "SELECT id FROM meeting_sessions WHERE meeting_id=$1 AND state='admitted'",
        [m.id],
      )
    ).rows[0]!.id;
    video.peers.push({ identity: sid, tracks: [] });
    video.fail = true;
    await new MeetingsService(f.db, video).recover();
    expect(
      (await f.db.query('SELECT state FROM meeting_sessions WHERE id=$1', [sid])).rows[0]?.state,
    ).toBe('removed');
    expect(
      (
        await f.db.query(
          "SELECT id FROM meeting_commands WHERE status='pending' AND payload->>'identity'=$1",
          [sid],
        )
      ).rows,
    ).toHaveLength(1);
    video.fail = false;
    await f.db.query("UPDATE meeting_commands SET retry_at=now()-interval '1 second'");
    await new MeetingsService(f.db, video).recover();
    expect(video.removed).toContain(sid);
  });
  it('requires a session-bound five-second server confirmation and derives guest IP from the trusted request', async () => {
    const m = await meeting(),
      g = await guest(m, '::ffff:192.0.2.50', 'Guest', {
        cookie: '',
        'x-forwarded-for': '203.0.113.99',
      }),
      other = await f.active('superadmin');
    const c = await prepare(m, g.sessionId);
    expect(c.ip).toBe('192.0.2.50');
    const row = (
      await f.db.query<{ ready_at: string; expires_at: string }>(
        'SELECT ready_at,expires_at FROM meeting_ban_confirmations WHERE id=$1',
        [c.id],
      )
    ).rows[0]!;
    expect(Date.parse(row.expires_at) - Date.parse(row.ready_at)).toBe(
      120000 - MEETING_BAN_HOLD_MS,
    );
    expect((await confirm(m.owner, c.id, 409)).json().error.code).toBe('BAN_HOLD_REQUIRED');
    await confirm(other, c.id, 404);
    await post(
      '/meeting-ip-bans/confirm',
      { cookie: m.owner.headers.cookie },
      { confirmationId: c.id },
      403,
    );
    expect((await f.db.query('SELECT id FROM meeting_ip_bans')).rows).toHaveLength(0);
    await mature(c.id);
    const b = (await confirm(m.owner, c.id)).json().data;
    expect(b).toMatchObject({
      ip: '192.0.2.50',
      owner: { id: m.owner.actor.user.id },
      reason: 'Leaked invitation',
      revision: 1,
    });
    expect((await confirm(m.owner, c.id)).json().data.id).toBe(b.id);
    expect((await f.db.query('SELECT id FROM meeting_ip_ban_events')).rows).toHaveLength(1);
    expect(video.removed).toContain(g.sessionId);
  });
  it('blocks new guest identities, existing cookies and reused links, without blocking registered accounts or unrelated meetings', async () => {
    const m = await meeting(),
      g = await guest(m),
      b = await ban(m, g);
    expect(
      (
        await f.app.inject({
          url: `/api/v1/meetings/${m.id}/room-state`,
          headers: g.headers,
          remoteAddress: g.ip,
        })
      ).statusCode,
    ).toBe(403);
    await post(`/meetings/${m.id}/sessions/${g.sessionId}/token`, g.headers, {}, 403, g.ip);
    await post(
      '/meeting-invites/redeem',
      { cookie: '', 'x-forwarded-for': '203.0.113.9' },
      { token: m.token, name: 'New identity', operationId: randomUUID() },
      403,
      g.ip,
    );
    const registered = await f.active();
    await post(
      '/meeting-invites/redeem',
      registered.headers,
      { token: m.token, operationId: randomUUID() },
      200,
      g.ip,
    );
    await guest(m, '192.0.2.51', 'Other IP');
    const another = await meeting();
    await guest(another, g.ip);
    const ended = await f.app.inject({ url: `/api/v1/meetings/${m.id}`, headers: m.owner.headers });
    await post(`/meetings/${m.id}/moderate`, m.owner.headers, {
      operationId: randomUUID(),
      action: 'end',
      revision: ended.json().data.revision,
    });
    const restarted = (
      await post(`/meetings/${m.id}/invite/restart`, m.owner.headers, { operationId: randomUUID() })
    ).json().data;
    expect(restarted.invite.id).toBe(b.inviteId);
    await post(
      '/meeting-invites/redeem',
      { cookie: '' },
      { token: m.token, name: 'Returned leak', operationId: randomUUID() },
      403,
      g.ip,
    );
  });
  it('restricts registry edits to owners/root, preserves the full attributed history and permits return after revocation', async () => {
    const m = await meeting(),
      g = await guest(m),
      b = await ban(m, g),
      root = await f.active('superadmin'),
      other = await f.active('teacher'),
      student = await f.active();
    const input = {
      operationId: randomUUID(),
      revision: b.revision,
      ip: b.ip,
      reason: 'Mistaken ban',
      active: false,
    };
    await post(`/meeting-ip-bans/${b.id}/prepare`, other.headers, input, 403);
    expect(
      (await f.app.inject({ url: '/api/v1/meeting-ip-bans', headers: student.headers })).statusCode,
    ).toBe(403);
    expect((await f.app.inject({ url: '/api/v1/meeting-ip-bans' })).statusCode).toBe(401);
    expect(
      meetingIpBansPageSchema.parse(
        (await f.app.inject({ url: '/api/v1/meeting-ip-bans', headers: other.headers })).json()
          .data,
      ).items,
    ).toHaveLength(0);
    await f.db.query(
      "INSERT INTO meeting_members(meeting_id,user_id,role) VALUES($1,$2,'organizer')",
      [m.id, other.actor.user.id],
    );
    const viewed = meetingIpBansPageSchema.parse(
      (
        await f.app.inject({
          url: `/api/v1/meeting-ip-bans?meetingId=${m.id}`,
          headers: other.headers,
        })
      ).json().data,
    );
    expect(viewed.items[0]!.canEdit).toBe(false);
    const c = (await post(`/meeting-ip-bans/${b.id}/prepare`, root.headers, input)).json().data;
    await mature(c.id);
    const revoked = meetingIpBanSchema.parse((await confirm(root, c.id)).json().data);
    expect(revoked).toMatchObject({
      active: false,
      revision: 2,
      owner: { id: m.owner.actor.user.id },
      updatedBy: { id: root.actor.user.id },
    });
    expect(revoked.history).toHaveLength(2);
    expect(revoked.history[0]).toMatchObject({
      kind: 'revoked',
      before: { active: true, reason: 'Leaked invitation' },
      after: { active: false, reason: 'Mistaken ban' },
    });
    await post(`/meetings/${m.id}/join`, g.headers, { operationId: randomUUID() }, 200, g.ip);
    const reactivate = (
      await post(`/meeting-ip-bans/${b.id}/prepare`, m.owner.headers, {
        ...input,
        operationId: randomUUID(),
        revision: 2,
        active: true,
        reason: 'Confirmed leak',
      })
    ).json().data;
    await mature(reactivate.id);
    expect((await confirm(m.owner, reactivate.id)).json().data.active).toBe(true);
    await post(
      `/meeting-ip-bans/${b.id}/prepare`,
      m.owner.headers,
      { ...input, operationId: randomUUID() },
      409,
    );
  });
  it('edits a canonical IPv6 address without affecting the old IP and rejects invalid, expired or injected requests', async () => {
    const m = await meeting();
    await post(
      `/meetings/${m.id}/ip-bans/prepare`,
      m.owner.headers,
      { operationId: randomUUID(), ip: '0.0.0.0/0', reason: 'Bad scope' },
      400,
    );
    await post(
      `/meetings/${m.id}/ip-bans/prepare`,
      m.owner.headers,
      { operationId: randomUUID(), ip: '192.0.2.1', sessionId: randomUUID(), reason: 'Ambiguous' },
      400,
    );
    const operationId = randomUUID();
    const c = (
      await post(`/meetings/${m.id}/ip-bans/prepare`, m.owner.headers, {
        operationId,
        ip: '2001:db8:0:0:0:0:0:5',
        reason: 'IPv6 leak',
      })
    ).json().data;
    expect(c.ip).toBe('2001:db8::5');
    await mature(c.id);
    await f.db.query(
      "UPDATE meeting_ban_confirmations SET expires_at=now()-interval '1 second' WHERE id=$1",
      [c.id],
    );
    await confirm(m.owner, c.id, 410);
    const restarted = (
      await post(`/meetings/${m.id}/ip-bans/prepare`, m.owner.headers, {
        operationId,
        ip: '2001:db8::5',
        reason: 'IPv6 leak',
      })
    ).json().data;
    expect(restarted.id).toBe(c.id);
    await confirm(m.owner, restarted.id, 409);
    expect((await f.db.query('SELECT id FROM meeting_ip_bans')).rows).toHaveLength(0);
    const g = await guest(m),
      b = await ban(m, g);
    const edit = (
      await post(`/meeting-ip-bans/${b.id}/prepare`, m.owner.headers, {
        operationId: randomUUID(),
        revision: 1,
        ip: '2001:db8::5',
        reason: 'Corrected address',
        active: true,
      })
    ).json().data;
    await mature(edit.id);
    await confirm(m.owner, edit.id);
    await guest(m, g.ip, 'Old IP permitted');
    await post(
      '/meeting-invites/redeem',
      { cookie: '' },
      { token: m.token, name: 'IPv6 denied', operationId: randomUUID() },
      403,
      '2001:db8:0:0::5',
    );
  });
});
