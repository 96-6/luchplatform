import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { loadSettings, projectRoot } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { AuthService } from '../apps/api/dist/modules/auth/service.js';
import { AccountCrypto } from '../apps/api/dist/modules/auth/crypto.js';
import { MailService } from '../apps/api/dist/modules/mail/service.js';
import { NetworkService } from '../apps/api/dist/modules/security/network.js';
import { MeetingsService } from '../apps/api/dist/modules/meetings/service.js';
import { MeetingInvites } from '../apps/api/dist/modules/meetings/invites.js';
import { MeetingFiles } from '../apps/api/dist/modules/meetings/files.js';
import { LiveKitVideo } from '../apps/api/dist/modules/meetings/adapter.js';
const settings = loadSettings(),
  verify = process.argv.includes('verify'),
  checkpoint = process.env.MEETING_FILES_SMOKE_FILE ?? '/tmp/luch-meeting-files-smoke.json';
assert.ok(
  settings.APP_ENV !== 'production' && settings.ENABLE_DEV_TOOLS,
  'Use an isolated development/test database.',
);
const db = await createDatabase(settings);
try {
  const crypto = new AccountCrypto(settings.AUTH_ENCRYPTION_KEY),
    auth = new AuthService(
      db,
      settings,
      crypto,
      new MailService(db, settings, crypto),
      new NetworkService(db, settings, crypto),
    ),
    files = new MeetingFiles(db, resolve(projectRoot, settings.MEETING_FILE_DIRECTORY)),
    meetings = new MeetingsService(db, new LiveKitVideo(settings), Date.now, files),
    invites = new MeetingInvites(auth, meetings);
  async function actor(role) {
    const email = `compose-meeting-files-${role}@example.test`;
    if (!verify)
      await db.query(
        'INSERT INTO users(id,email,full_name,role,is_demo) VALUES($1,$2,$3,$4,true) ON CONFLICT(email) DO NOTHING',
        [randomUUID(), email, 'Meeting file persistence fixture', role],
      );
    const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    assert.ok(row);
    return { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'fixture' };
  }
  const teacher = await actor('teacher'),
    root = await actor('superadmin');
  const bytes = Buffer.from('Meeting file retained across application restart.');
  if (!verify) {
    const input = {
      operationId: randomUUID(),
      title: 'Compose ad hoc files',
      description: '',
      language: 'en',
      timeZone: 'UTC',
      durationMinutes: null,
      reusable: true,
      allowGuests: true,
      expiresAt: null,
      lobbyEnabled: false,
    };
    const created = await invites.create(teacher, input),
      id = created.meeting.id;
    assert.equal(created.meeting.endsAt, null);
    await meetings.join(teacher, id, randomUUID());
    const token = new URL(created.invite.url).searchParams.get('token'),
      joinOperation = randomUUID(),
      cookie = {};
    const joined = await invites.redeem(
      { cookies: {}, headers: {} },
      {
        setCookie(name, value) {
          cookie[name] = value;
        },
      },
      { operationId: joinOperation, token, name: 'Persistent guest' },
    );
    const guest = {
      user: { id: joined.guest.id, name: joined.guest.name, role: 'guest' },
      sessionId: joined.guest.id,
      tokenHash: '',
    };
    await meetings.join(guest, id, randomUUID());
    let policy = await files.policy();
    await files.updatePolicy(root, { ...policy, maxFileMb: 2, largeFileMb: 0, retentionDays: 10 });
    const uploadOperation = randomUUID(),
      messageOperation = randomUUID();
    const file = await files.upload(
      guest,
      id,
      uploadOperation,
      'persisted.txt',
      Readable.from(bytes),
      bytes.length,
    );
    assert.ok(file.expiresAt);
    await meetings.send(guest, id, messageOperation, 'Persisted guest attachment', [file.id]);
    policy = await files.policy();
    await files.updatePolicy(root, {
      ...policy,
      maxFileMb: 125,
      largeFileMb: 50,
      retentionDays: 10,
    });
    await writeFile(
      checkpoint,
      JSON.stringify({
        id,
        input,
        invitation: created.invite,
        token,
        joinOperation,
        cookie,
        guest,
        file,
        uploadOperation,
        messageOperation,
      }),
    );
    console.log(
      'Ad hoc reusable invitation, scoped guest, policy, chat attachment metadata and private file bytes persisted.',
    );
  } else {
    const saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    const current = await meetings.read(teacher, saved.id);
    assert.equal(current.kind, 'adhoc');
    assert.equal(current.endsAt, null);
    assert.deepEqual(await invites.read(teacher, saved.id), saved.invitation);
    const replay = await invites.redeem(
      { cookies: saved.cookie, headers: {} },
      { setCookie() {} },
      { operationId: saved.joinOperation, token: saved.token, name: saved.guest.user.name },
    );
    assert.equal(replay.guest.id, saved.guest.user.id);
    assert.equal(replay.guest.admitted, true);
    const attachment = await files.download(saved.guest, saved.id, saved.file.id),
      chunks = [];
    for await (const chunk of attachment.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
    assert.deepEqual(
      await files.upload(
        saved.guest,
        saved.id,
        saved.uploadOperation,
        'persisted.txt',
        Readable.from(bytes),
        bytes.length,
      ),
      saved.file,
    );
    await meetings.send(
      saved.guest,
      saved.id,
      saved.messageOperation,
      'Persisted guest attachment',
      [saved.file.id],
    );
    const messages = await meetings.messages(teacher, saved.id);
    assert.equal(messages.items.length, 1);
    assert.equal(messages.items[0].attachments[0].expiresAt, saved.file.expiresAt);
    await db.query("UPDATE meeting_files SET expires_at=now()-interval '1 second' WHERE id=$1", [
      saved.file.id,
    ]);
    await assert.rejects(files.download(saved.guest, saved.id, saved.file.id), { statusCode: 410 });
    await files.cleanup();
    await assert.rejects(stat(resolve(files.directory, attachment.file.storage_key)), {
      code: 'ENOENT',
    });
    assert.equal(
      (await meetings.messages(teacher, saved.id)).items[0].attachments[0].deleted,
      true,
    );
    const policy = await files.policy();
    assert.equal(policy.maxFileMb, 125);
    assert.equal(policy.largeFileMb, 50);
    assert.equal(policy.retentionDays, 10);
    console.log(
      'Meeting file restart verified: stable invite and guest, unchanged attachment deadline, original bytes, idempotent upload/message, persisted policy, expired download 410 and physical cleanup with chat history retained.',
    );
  }
} finally {
  await db.close();
}
