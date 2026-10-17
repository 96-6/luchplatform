import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterAll, describe, it, expect } from 'vitest';
import { learningReportViewSchema, integrityStatsSchema, type RunView } from '@luch/contracts';
import { learningFixture, type Login } from './helpers/learning.js';
import { ReportsService } from '../src/modules/reports/service.js';
import { ContentService } from '../src/modules/content/service.js';
import type { Database } from '../src/db/database.js';
import { evidenceWeight } from '../src/modules/reports/integrity.js';
let f: Awaited<ReturnType<typeof learningFixture>>;
beforeAll(async () => {
  f = await learningFixture();
});
beforeEach(async () => {
  await f.reset();
});
afterAll(async () => {
  await f.app.close();
});
async function group() {
  const student = await f.active(),
    teacher = await f.active('teacher');
  await f.db.query('INSERT INTO teacher_students (teacher_id,student_id) VALUES ($1,$2)', [
    teacher.actor.user.id,
    student.actor.user.id,
  ]);
  return { student, teacher };
}
async function report(actor: Login, userId = actor.actor.user.id, language: 'ru' | 'en' = 'ru') {
  const r = await f.app.inject({
    url: `/api/v1/reports/${userId}?language=${language}`,
    headers: actor.headers,
  });
  expect(r.statusCode, r.body).toBe(200);
  return learningReportViewSchema.parse(r.json().data);
}
async function lesson(student: Login, language: 'ru' | 'en' = 'ru', purpose = 'practice') {
  const r = await f.app.inject({
    method: 'POST',
    url: '/api/v1/engine/runs',
    headers: student.headers,
    payload: {
      packageId: 'luch-demo',
      restart: true,
      source: { type: 'lesson', id: language === 'ru' ? 'rki-01' : 'english-01', purpose },
    },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().data as RunView;
}
async function signal(student: Login, run: RunView) {
  await f.db.query("UPDATE engine_turns SET started_at=now()-interval '5 seconds' WHERE id=$1", [
    run.current!.turn.id,
  ]);
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/v1/engine/runs/${run.run.id}/integrity`,
    headers: student.headers,
    payload: {
      turnId: run.current!.turn.id,
      batchId: randomUUID(),
      stats: integrityStatsSchema.parse({
        durationMilliseconds: 3000,
        hiddenMilliseconds: 500,
        tabHides: 1,
        pasteEvents: 1,
      }),
    },
  });
  expect(r.statusCode, r.body).toBe(200);
}
async function review(teacher: Login, id: string, fields: Record<string, unknown> = {}) {
  const r = await f.app.inject({
    method: 'POST',
    url: `/api/v1/teacher/attempts/${id}/reviews`,
    headers: teacher.headers,
    payload: {
      operationId: randomUUID(),
      revision: 0,
      decision: 'correct',
      correct: true,
      comment: 'Проверено по ответу ученика.',
      ...fields,
    },
  });
  expect(r.statusCode, r.body).toBe(200);
}
describe('live learning reports', () => {
  it('shows an honest empty report, stored skill catalogue and the same public report to the assigned teacher', async () => {
    const g = await group(),
      s = await report(g.student),
      t = await report(g.teacher, g.student.actor.user.id);
    expect(s.report).toEqual(t.report);
    expect(s.reviewer).toBeNull();
    expect(t.reviewer!.assessedAttempts).toBe(0);
    expect(s.report.counts.submittedAttempts).toBe(0);
    expect(s.report.skills).toHaveLength(6);
    expect(s.report.skills.every((k) => k.state === null && k.counts.evaluatedAttempts === 0)).toBe(
      true,
    );
    expect(s.report.next.plan).toBeNull();
    expect(s.report.next.assignments).toHaveLength(0);
  });
  it('gives saved hidden observations a private weight without changing grades or the shared report', async () => {
    const g = await group();
    let run = await lesson(g.student);
    await signal(g.student, run);
    run = await f.answer(g.student, run, true);
    const s = await report(g.student),
      t = await report(g.teacher, g.student.actor.user.id);
    expect(s.report).toEqual(t.report);
    expect(s.reviewer).toBeNull();
    expect(s.report.counts).toMatchObject({
      evaluatedAttempts: 1,
      correctAttempts: 1,
      independentCorrect: 1,
      teacherReviewedAttempts: 0,
    });
    expect(t.reviewer).toMatchObject({
      assessedAttempts: 1,
      flaggedAttempts: 1,
      requiresReviewAttempts: 1,
      weightedEvidenceUnits: 0.8,
      evidenceReductionUnits: 0.2,
    });
    expect(t.reviewer!.attempts.items[0]!.weightBasisPoints).toBe(8000);
    expect(t.reviewer!.signalImpact.reduce((n, x) => n + x.evidenceReductionBasisPoints, 0)).toBe(
      2000,
    );
    const attempt = (
      await f.db.query<{ is_correct: boolean; teacher_correct: boolean | null }>(
        'SELECT is_correct,teacher_correct FROM engine_attempts WHERE id=$1',
        [run.current!.attempt!.id],
      )
    ).rows[0]!;
    expect(attempt).toEqual({ is_correct: true, teacher_correct: null });
    expect(JSON.stringify(s)).not.toMatch(
      /window_changes|answer_paste|weightedEvidence|assessment|pointer_pattern/,
    );
  });
  it('counts help, final teacher decisions and actual completed steps separately, keeping automatic errors', async () => {
    const g = await group();
    let run = await lesson(g.student);
    run = await f.answer(g.student, run, false);
    const first = run.current!.attempt!.id;
    run = await f.next(g.student, run);
    const hint = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/hint`,
      headers: g.student.headers,
      payload: { turnId: run.current!.turn.id, index: 0 },
    });
    expect(hint.statusCode, hint.body).toBe(200);
    run = await f.answer(g.student, run, true);
    await f.next(g.student, run);
    await review(g.teacher, first);
    const s = await report(g.student),
      t = await report(g.teacher, g.student.actor.user.id);
    expect(s.report).toEqual(t.report);
    expect(s.report.counts).toMatchObject({
      submittedAttempts: 2,
      correctAttempts: 2,
      automaticIncorrectAttempts: 1,
      independentCorrect: 1,
      assistedCorrect: 1,
      hintedCorrect: 1,
      teacherReviewedAttempts: 1,
      teacherCorrectedAttempts: 1,
    });
    expect(s.report.completion).toMatchObject({
      completedSteps: 2,
      uniqueExercises: 2,
      completedRuns: 1,
      completedLessons: 1,
    });
    await review(g.teacher, first, {
      revision: 1,
      decision: 'comment',
      correct: undefined,
      comment: 'Дополнительный комментарий.',
    });
    const next = await report(g.student);
    expect(next.report.counts.teacherReviewedAttempts).toBe(1);
    expect(
      next.report.recentAttempts.items.find((a) => a.id === first)!.teacherReview!.decision,
    ).toBe('correct');
    expect(next.report.revision).not.toBe(s.report.revision);
  });
  it('keeps missing observations unknown without reducing evidence weight', async () => {
    const g = await group();
    await f.answer(g.student, await lesson(g.student), true);
    const t = await report(g.teacher, g.student.actor.user.id);
    expect(t.reviewer).toMatchObject({
      assessedAttempts: 0,
      insufficientDataAttempts: 1,
      independentCorrectWithoutData: 1,
      weightedEvidenceUnits: 1,
      evidenceReductionUnits: 0,
    });
  });
  it('caps combined weights, ignores duplicate and unknown signals and allocates visible contributions exactly', () => {
    const codes = [
      'window_changes',
      'answer_paste',
      'pointer_pattern',
      'short_response_interval',
      'answer_paste',
      'new_unknown',
    ];
    const w = evidenceWeight(codes, true);
    expect(w.weightBasisPoints).toBe(7000);
    expect(w.deductions.reduce((n, x) => n + x.reductionBasisPoints, 0)).toBe(3000);
    expect(w.deductions).toHaveLength(4);
    expect(w.unknownSignalCodes).toEqual(['new_unknown']);
    expect(evidenceWeight(codes, false).weightBasisPoints).toBe(10000);
    expect(evidenceWeight([], true).weightBasisPoints).toBe(10000);
  });
});

describe('report evidence, privacy and continuity', () => {
  it('enforces current student/teacher scope on every report and page endpoint', async () => {
    const g = await group(),
      stranger = await f.active(),
      outsider = await f.active('teacher'),
      admin = await f.active('admin'),
      root = await f.active('superadmin');
    const paths = ['', '/attempts', '/changes', '/integrity'];
    for (const suffix of paths) {
      const url = `/api/v1/reports/${g.student.actor.user.id}${suffix}?language=ru`;
      expect((await f.app.inject({ url })).statusCode).toBe(401);
      for (const actor of [stranger, outsider, admin]) {
        const r = await f.app.inject({ url, headers: actor.headers });
        expect([403, 404], r.body).toContain(r.statusCode);
        expect(r.body).not.toContain(g.student.actor.user.email);
      }
    }
    expect(
      (
        await f.app.inject({
          url: `/api/v1/reports/${g.student.actor.user.id}/integrity?language=ru`,
          headers: g.student.headers,
        })
      ).statusCode,
    ).toBe(403);
    expect((await report(root, g.student.actor.user.id)).report).toEqual(
      (await report(g.student)).report,
    );
    for (const query of [
      'language=de',
      'language=ru&beforeId=' + randomUUID(),
      'language=ru&limit=1000',
      'language=ru&reviewer=true',
    ]) {
      const endpoint = query.includes('beforeId') || query.includes('limit') ? '/attempts' : '';
      expect(
        (
          await f.app.inject({
            url: `/api/v1/reports/${g.student.actor.user.id}${endpoint}?${query}`,
            headers: g.teacher.headers,
          })
        ).statusCode,
      ).toBe(400);
    }
    await f.db.query('DELETE FROM teacher_students WHERE teacher_id=$1', [g.teacher.actor.user.id]);
    for (const suffix of paths)
      expect(
        (
          await f.app.inject({
            url: `/api/v1/reports/${g.student.actor.user.id}${suffix}?language=ru`,
            headers: g.teacher.headers,
          })
        ).statusCode,
      ).toBe(404);
  });
  it.each(['diagnostic', 'control'])(
    'withholds unfinished %s grades from every common aggregate and the private weights',
    async (purpose) => {
      const g = await group();
      let run = await lesson(g.student, 'ru', purpose);
      await signal(g.student, run);
      run = await f.answer(g.student, run, true);
      const before = await report(g.student),
        teacher = await report(g.teacher, g.student.actor.user.id);
      expect(before.report).toEqual(teacher.report);
      expect(before.report.counts).toMatchObject({
        submittedAttempts: 1,
        evaluatedAttempts: 0,
        pendingEvaluationAttempts: 1,
        correctAttempts: 0,
        independentCorrect: 0,
      });
      expect(before.report.recentAttempts.items[0]).toMatchObject({
        correct: null,
        automaticCorrect: null,
        independent: null,
        help: [],
        teacherReview: null,
      });
      expect(before.report.repeatedErrors).toHaveLength(0);
      expect(before.report.skills.every((s) => s.counts.evaluatedAttempts === 0)).toBe(true);
      expect(teacher.reviewer).toMatchObject({
        assessedAttempts: 0,
        weightedEvidenceUnits: 0,
        flaggedAttempts: 0,
      });
      await f.next(g.student, run);
      await f.finish(g.student, run.run.id);
      const after = await report(g.student);
      expect(after.report.counts.pendingEvaluationAttempts).toBe(0);
      expect(after.report.counts.evaluatedAttempts).toBeGreaterThan(0);
      expect(after.report.revision).not.toBe(before.report.revision);
    },
  );
  it('derives recurring mistakes from current grades and removes a pattern after a teacher correction', async () => {
    const g = await group(),
      run = await lesson(g.student);
    await f.finish(g.student, run.run.id, [false, false]);
    const before = await report(g.student);
    expect(before.report.repeatedErrors).toHaveLength(1);
    expect(before.report.repeatedErrors[0]).toMatchObject({ mistakes: 2, exercises: 2 });
    await review(g.teacher, before.report.recentAttempts.items[0]!.id);
    const after = await report(g.student);
    expect(after.report.repeatedErrors).toHaveLength(0);
    expect(after.report.counts).toMatchObject({
      incorrectAttempts: 1,
      automaticIncorrectAttempts: 2,
      teacherCorrectedAttempts: 1,
    });
    expect(after.report.skills.find((s) => s.counts.evaluatedAttempts)!.state!.mistakes).toBe(1);
  });
  it('keeps languages, saved goals and pinned diagnostic results separate after profile changes', async () => {
    const g = await group(),
      ru = await f.preparedPlan(g.student, { language: 'ru', goal: 'travel' });
    let r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/learning/profile',
      headers: g.student.headers,
      payload: { language: 'en', goal: 'work', experience: 'some', minutesPerDay: 35, revision: 1 },
    });
    expect(r.statusCode, r.body).toBe(200);
    r = await f.app.inject({
      method: 'POST',
      url: '/api/v1/diagnostics',
      headers: g.student.headers,
      payload: { profileRevision: 2 },
    });
    expect(r.statusCode, r.body).toBe(200);
    await f.finish(g.student, r.json().data.diagnostic.runId);
    const russian = (await report(g.student, g.student.actor.user.id, 'ru')).report,
      english = (await report(g.student, g.student.actor.user.id, 'en')).report;
    expect(russian.profile).toMatchObject({ language: 'ru', goal: 'travel', revision: 1 });
    expect(english.profile).toMatchObject({ language: 'en', goal: 'work', revision: 2 });
    expect(russian.next.plan!.id).toBe(ru.plan.id);
    expect(english.next.plan!.id).not.toBe(ru.plan.id);
    expect(russian.counts.submittedAttempts).toBe(6);
    expect(english.counts.submittedAttempts).toBe(6);
    expect(russian.diagnostic!.result!.correct).toBe(6);
    expect(english.diagnostic!.result!.correct).toBe(6);
    const defaultReport = await f.app.inject({
      url: '/api/v1/reports/me',
      headers: g.student.headers,
    });
    expect(defaultReport.json().data.report.language).toBe('en');
  });
  it('shows actual adaptive changes and teacher rescheduling/cancellation without creating work on reads', async () => {
    const g = await group(),
      plan = await f.preparedPlan(g.student),
      run = await f.start(g.student, plan.plan.id, plan.assignments[0]!.id);
    await f.finish(g.student, run.run.id, [false, false]);
    let r = await f.app.inject({
      method: 'POST',
      url: `/api/v1/teacher/plans/${plan.plan.id}/assignments`,
      headers: g.teacher.headers,
      payload: {
        operationId: randomUUID(),
        exerciseId: 'rki-02-practice-text',
        reason: 'Подготовка к беседе после занятия.',
        dueAt: null,
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    const assigned = r.json().data.assignments.find((a: { kind: string }) => a.kind === 'teacher');
    r = await f.app.inject({
      method: 'POST',
      url: `/api/v1/teacher/plans/${plan.plan.id}/assignments/${assigned.id}`,
      headers: g.teacher.headers,
      payload: {
        operationId: randomUUID(),
        revision: 0,
        action: 'reschedule',
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        reason: 'Перенос по учебной нагрузке.',
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    r = await f.app.inject({
      method: 'POST',
      url: `/api/v1/teacher/plans/${plan.plan.id}/assignments/${assigned.id}`,
      headers: g.teacher.headers,
      payload: {
        operationId: randomUUID(),
        revision: 1,
        action: 'cancel',
        dueAt: null,
        reason: 'Заменяем другой практикой.',
      },
    });
    expect(r.statusCode, r.body).toBe(200);
    const snapshot = async () =>
      JSON.stringify(
        (
          await f.db.query(`SELECT
      (SELECT count(*) FROM engine_attempts) AS attempts,(SELECT count(*) FROM engine_events) AS events,
      (SELECT count(*) FROM skill_observations) AS observations,(SELECT count(*) FROM plan_assignments) AS assignments,
      (SELECT count(*) FROM learning_plan_changes) AS changes,(SELECT count(*) FROM teacher_reviews) AS reviews`)
        ).rows,
      );
    const rawBefore = await snapshot(),
      s = await report(g.student),
      t = await report(g.teacher, g.student.actor.user.id);
    expect(await snapshot()).toBe(rawBefore);
    expect(s.report).toEqual(t.report);
    expect(s.report.completion).toMatchObject({ completedAssignments: 1, cancelledAssignments: 1 });
    expect(s.report.next.assignments.some((a) => a.id === assigned.id)).toBe(false);
    expect(s.report.next.assignments.some((a) => a.kind === 'correction')).toBe(true);
    expect(s.report.planChanges.items.map((c) => c.action)).toEqual(
      expect.arrayContaining([
        'correction_added',
        'teacher_assignment_added',
        'teacher_assignment_rescheduled',
        'teacher_assignment_cancelled',
      ]),
    );
    expect(s.report.planChanges.items.some((c) => c.reason === 'Заменяем другой практикой.')).toBe(
      true,
    );
  });
  it('counts a repeated delivery once and does not count rejected input as a learning attempt', async () => {
    const g = await group(),
      run = await lesson(g.student),
      operationId = randomUUID();
    await f.answer(g.student, run, true, operationId);
    const before = await report(g.student);
    await f.answer(g.student, run, true, operationId);
    const rejected = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/answer`,
      headers: g.student.headers,
      payload: {
        turnId: run.current!.turn.id,
        operationId: randomUUID(),
        answer: { type: 'short_text', text: '' },
      },
    });
    expect(rejected.statusCode).toBe(400);
    expect((await report(g.student)).report).toEqual(before.report);
  });
  it('keeps input accessibility observations and other-actor help distinct from independent success', async () => {
    const g = await group(),
      root = await f.active('superadmin');
    let run = await lesson(g.student);
    await f.db.query("UPDATE engine_turns SET started_at=now()-interval '5 seconds' WHERE id=$1", [
      run.current!.turn.id,
    ]);
    const packet = await f.app.inject({
      method: 'POST',
      url: `/api/v1/engine/runs/${run.run.id}/integrity`,
      headers: g.student.headers,
      payload: {
        turnId: run.current!.turn.id,
        batchId: randomUUID(),
        stats: integrityStatsSchema.parse({
          durationMilliseconds: 2000,
          keyboardNavigation: true,
          pointerTypes: ['touch'],
          syntheticEvents: 8,
        }),
      },
    });
    expect(packet.statusCode).toBe(200);
    run = await f.answer(g.student, run, true);
    run = await f.next(g.student, run);
    await f.answer(root, run, true);
    const s = await report(g.student),
      t = await report(g.teacher, g.student.actor.user.id);
    expect(s.report.counts).toMatchObject({
      independentCorrect: 1,
      assistedCorrect: 1,
      otherAssistedCorrect: 1,
    });
    expect(s.report.recentAttempts.items[0]!.help).toEqual(
      expect.arrayContaining(['administrator', 'other_actor']),
    );
    expect(t.reviewer).toMatchObject({
      weightedEvidenceUnits: 1,
      evidenceReductionUnits: 0,
      flaggedAttempts: 0,
    });
  });
  it('aggregates the whole history and keeps old private context beyond the recent page', async () => {
    const g = await group();
    let flagged = '';
    for (let i = 0; i < 53; i++) {
      let run = await lesson(g.student);
      if (i === 0) {
        await signal(g.student, run);
        run = await f.answer(g.student, run, true);
        flagged = run.current!.attempt!.id;
      }
      await f.finish(g.student, run.run.id);
    }
    await f.db.query(
      "UPDATE engine_attempts SET evaluated_at='2026-10-17T09:00:00Z' WHERE user_id=$1",
      [g.student.actor.user.id],
    );
    const s = await report(g.student),
      t = await report(g.teacher, g.student.actor.user.id);
    expect(s.report.counts.submittedAttempts).toBe(106);
    expect(s.report.completion).toMatchObject({
      completedSteps: 106,
      uniqueExercises: 2,
      completedRuns: 53,
    });
    expect(s.report.recentAttempts.items).toHaveLength(20);
    expect(t.reviewer!.flaggedAttempts).toBe(1);
    expect(t.reviewer!.attempts.items[0]!.id).toBe(flagged);
    expect(s.report.counts).toMatchObject({ independentCorrect: 2, assistedCorrect: 104 });
    expect(t.reviewer!.weightedEvidenceUnits).toBe(1.8);
    const ids: string[] = [];
    let cursor: { createdAt: string; id: string } | null = null;
    do {
      const q = new URLSearchParams({
          language: 'ru',
          limit: '17',
          ...(cursor ? { beforeCreatedAt: cursor.createdAt, beforeId: cursor.id } : {}),
        }),
        response = await f.app.inject({
          url: `/api/v1/reports/${g.student.actor.user.id}/attempts?${q}`,
          headers: g.student.headers,
        });
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json().data;
      ids.push(...page.items.map((a: { id: string }) => a.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(106);
    expect(ids).toHaveLength(106);
  }, 60000);
  it('retains pinned skill labels and separate states after publishing a new content revision', async () => {
    const g = await group(),
      run = await lesson(g.student);
    await f.finish(g.student, run.run.id);
    const next = structuredClone(f.demo);
    next.package.version = 2;
    const skillId = next.exercises.find((e) => e.lessonId === 'rki-01')!.skillId;
    const skill = next.skills.find((s) => s.id === skillId)!;
    const original = skill.title;
    skill.title = 'Новая редакция навыка';
    await new ContentService(f.db).import(next);
    const r = (await report(g.student)).report;
    expect(r.skills.find((s) => s.skillId === skill.id && s.packageVersion === 1)!.title).toBe(
      original,
    );
    expect(
      r.skills.find((s) => s.skillId === skill.id && s.packageVersion === 2)!.state,
    ).toBeNull();
    expect(r.counts.submittedAttempts).toBe(2);
  });
  it.runIf(Boolean(process.env.TEST_DATABASE_URL))(
    'reads one PostgreSQL snapshot while an answer commits concurrently',
    async () => {
      const g = await group(),
        run = await lesson(g.student);
      let injected = false;
      const db: Database = {
        ...f.db,
        transaction: (work) =>
          f.db.transaction((tx) =>
            work({
              ...tx,
              query: async (sql, params) => {
                const result = await tx.query(sql, params);
                if (
                  !injected &&
                  sql.includes(' AS submitted,') &&
                  sql.includes('FROM evidence e')
                ) {
                  injected = true;
                  await f.answer(g.student, run, true);
                }
                return result;
              },
            }),
          ),
      };
      const during = await new ReportsService(db).read(g.student.actor, g.student.actor.user.id, {
        language: 'ru',
      });
      expect(injected).toBe(true);
      expect(during.report.counts.submittedAttempts).toBe(0);
      expect(during.report.recentAttempts.items).toHaveLength(0);
      expect((await report(g.student)).report.counts.submittedAttempts).toBe(1);
    },
  );
});
