import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadSettings } from '../apps/api/dist/config.js';
import { createDatabase } from '../apps/api/dist/db/database.js';
import { publicUser } from '../apps/api/dist/modules/accounts/repository.js';
import { DiagnosticsService } from '../apps/api/dist/modules/diagnostics/service.js';
import { PlansService } from '../apps/api/dist/modules/plans/service.js';
import { MeetingsService } from '../apps/api/dist/modules/meetings/service.js';
import { LiveKitVideo } from '../apps/api/dist/modules/meetings/adapter.js';
const settings = loadSettings(),
  verify = process.argv.includes('verify'),
  offline = process.argv.includes('--offline');
assert.ok(
  settings.APP_ENV !== 'production' && settings.ENABLE_DEV_TOOLS,
  'Use an isolated development/test database.',
);
assert.ok(!offline || settings.APP_ENV === 'test', 'Offline persistence fixtures are test-only.');
const fake = {
  configured: true,
  browserUrl: 'ws://127.0.0.1:7880',
  async ensureRoom() {},
  async participants() {
    return [];
  },
  async permissions() {},
  async remove() {},
  async close() {},
  async token() {
    return 'offline-persistence-fixture';
  },
};
const db = await createDatabase(settings);
try {
  const meetings = new MeetingsService(db, offline ? fake : new LiveKitVideo(settings)),
    plans = new PlansService(db),
    diagnostics = new DiagnosticsService(db);
  async function actor(name, role = 'student') {
    const email = `compose-meeting-${name}@example.test`;
    if (!verify)
      await db.query(
        'INSERT INTO users (id,email,full_name,role,is_demo) VALUES ($1,$2,$3,$4,true) ON CONFLICT (email) DO NOTHING',
        [randomUUID(), email, `Video persistence ${name}`, role],
      );
    const row = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    assert.ok(row);
    return { user: publicUser(row), sessionId: randomUUID(), tokenHash: 'fixture' };
  }
  async function answer(view) {
    const e = await plans.engine.content.definition(
      'exercises',
      view.run.packageId,
      view.run.packageVersion,
      view.current.exercise.id,
    );
    return e.solution.type === 'short_text'
      ? { type: 'short_text', text: e.solution.accepted[0] }
      : { type: 'choice', optionId: e.solution.correctOptionIds[0] };
  }
  async function planFor(student, language) {
    const existing = (
      await db.query(
        'SELECT id FROM learning_plans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
        [student.user.id],
      )
    ).rows[0];
    if (existing) return plans.read(student, existing.id);
    assert.equal(verify, false);
    await diagnostics.profiles.save(student, {
      language,
      goal: 'daily_life',
      experience: 'none',
      minutesPerDay: 20,
      revision: 0,
    });
    const d = await diagnostics.start(student, { profileRevision: 1, restart: false });
    let v = await plans.engine.repository.view(student, d.diagnostic.runId);
    while (v.current) {
      v = (
        await plans.engine.answer(student, v.run.id, {
          turnId: v.current.turn.id,
          operationId: randomUUID(),
          answer: await answer(v),
        })
      ).view;
      v = await plans.engine.next(student, v.run.id, v.current.turn.id);
    }
    return plans.read(student, (await diagnostics.read(student, d.diagnostic.id)).planId);
  }
  const teacher = await actor('teacher', 'teacher');
  for (const language of ['ru', 'en']) {
    const student = await actor(language),
      peer = await actor(`${language}-peer`);
    if (!verify)
      for (const p of [student, peer])
        await db.query(
          'INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [teacher.user.id, p.user.id],
        );
    const plan = await planFor(student, language);
    const title = `Compose video ${language}`;
    if (!verify) {
      const draft = {
        operationId: randomUUID(),
        title,
        description: 'Практика языка',
        language,
        startsAt: new Date(Date.now() - 60000).toISOString(),
        endsAt: new Date(Date.now() + 3600000).toISOString(),
        timeZone: 'Europe/Moscow',
        organizerId: teacher.user.id,
        coorganizerIds: [],
        studentIds: [student.user.id, peer.user.id],
        lobbyEnabled: true,
      };
      let m = await meetings.create(teacher, draft);
      await meetings.join(teacher, m.id, randomUUID());
      m = await meetings.read(teacher, m.id);
      await meetings.moderate(teacher, m.id, {
        operationId: randomUUID(),
        action: 'end',
        revision: m.revision,
      });
      await meetings.summary(teacher, m.id, {
        operationId: randomUUID(),
        revision: 0,
        comment: 'Итог встречи сохранён. Выполните назначенную практику.',
        homework: [
          {
            studentId: student.user.id,
            planId: plan.plan.id,
            exerciseId: language === 'ru' ? 'rki-02-practice-text' : 'english-02-practice-text',
            reason: 'Закрепляем тему видеозанятия.',
            dueAt: null,
          },
        ],
      });
      let live = await meetings.create(teacher, {
        ...draft,
        operationId: randomUUID(),
        title: `${title} active`,
      });
      await meetings.join(teacher, live.id, randomUUID());
      const s = await meetings.join(student, live.id, randomUUID());
      await meetings.moderate(teacher, live.id, {
        operationId: randomUUID(),
        action: 'admit',
        targetId: s.session.id,
      });
      await meetings.hand(student, live.id, s.session.id, true);
      await meetings.send(student, live.id, randomUUID(), 'Сохранённый вопрос ученика.');
      await meetings.moderate(teacher, live.id, {
        operationId: randomUUID(),
        action: 'mute_audio',
        targetId: s.session.id,
      });
      live = await meetings.read(teacher, live.id);
      await meetings.moderate(teacher, live.id, {
        operationId: randomUUID(),
        action: 'lock',
        revision: live.revision,
      });
      let cancelled = await meetings.create(teacher, {
        ...draft,
        operationId: randomUUID(),
        title: `${title} cancelled`,
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        endsAt: new Date(Date.now() + 90000000).toISOString(),
      });
      cancelled = await meetings.update(teacher, cancelled.id, {
        ...draft,
        operationId: randomUUID(),
        revision: 1,
        title: `${title} cancelled`,
        startsAt: new Date(Date.now() + 2 * 86400000).toISOString(),
        endsAt: new Date(Date.now() + 2 * 86400000 + 3600000).toISOString(),
      });
      await meetings.moderate(teacher, cancelled.id, {
        operationId: randomUUID(),
        action: 'cancel',
        revision: cancelled.revision,
      });
    } else {
      const rows = (
        await db.query(
          'SELECT id,title FROM scheduled_meetings WHERE organizer_id=$1 AND title LIKE $2',
          [teacher.user.id, `${title}%`],
        )
      ).rows;
      assert.equal(rows.length, 3);
      const id = rows.find((m) => m.title === title).id,
        m = await meetings.read(student, id);
      assert.equal(m.status, 'completed');
      assert.equal(m.members.length, 3);
      assert.ok(m.summaryComment.includes('Итог встречи'));
      assert.equal(m.homework.length, 1);
      assert.equal((await meetings.read(peer, id)).homework.length, 0);
      const operations = (
        await db.query(
          "SELECT * FROM meeting_operations WHERE meeting_id=$1 AND kind IN ('create','summary') ORDER BY created_at",
          [id],
        )
      ).rows;
      for (const op of operations) {
        if (op.kind === 'create') await meetings.create(teacher, op.request);
        else {
          const { id: mid, ...payload } = op.request;
          await meetings.summary(teacher, mid, payload);
        }
      }
      assert.equal((await meetings.read(student, id)).homework.length, 1);
      const liveId = rows.find((m) => m.title === `${title} active`).id,
        saved = (
          await db.query(
            "SELECT id FROM meeting_sessions WHERE meeting_id=$1 AND user_id=$2 AND state='admitted'",
            [liveId, student.user.id],
          )
        ).rows[0];
      assert.ok(saved);
      let state = await meetings.room(student, liveId, saved.id);
      assert.equal(state.meeting.locked, true);
      assert.equal(state.self.audioAllowed, false);
      assert.ok(state.self.handRaisedAt);
      assert.equal((await meetings.join(student, liveId, randomUUID())).session.id, saved.id);
      assert.equal(
        (await meetings.messages(student, liveId)).items[0].text,
        'Сохранённый вопрос ученика.',
      );
      await meetings.token(student, liveId, saved.id);
      const end = await meetings.read(teacher, liveId);
      await meetings.moderate(teacher, liveId, {
        operationId: randomUUID(),
        action: 'end',
        revision: end.revision,
      });
      const cancelled = await meetings.read(
        student,
        rows.find((m) => m.title === `${title} cancelled`).id,
      );
      assert.equal(cancelled.status, 'cancelled');
      await assert.rejects(meetings.join(student, cancelled.id, randomUUID()), {
        code: 'MEETING_CLOSED',
      });
      const homework = await plans.startAssignment(
        student,
        m.homework[0].planId,
        m.homework[0].assignmentId,
      );
      assert.equal(homework.run.sourceType, 'assignment');
      assert.equal(
        homework.current.exercise.id,
        language === 'ru' ? 'rki-02-practice-text' : 'english-02-practice-text',
      );
    }
  }
  console.log(
    verify
      ? 'Meeting restart verified for RU/EN: calendars, participant roles, rescheduling/cancellation, lobby/admission, locked reconnect, media policy, hand, chat, summary and exact homework restored; repeats are safe and homework starts in the existing engine.'
      : 'Meeting calendars, active room state, moderation, chat, lesson summaries and linked plan homework persisted for RU/EN.',
  );
} finally {
  await db.close();
}
