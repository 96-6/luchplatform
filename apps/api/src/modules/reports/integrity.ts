import {
  integrityAssessmentSchema,
  reportIntegritySchema,
  reportIntegrityAttemptSchema,
} from '@luch/contracts';
import type { QueryExecutor } from '../../db/database.js';
import { iso } from '../engine/repository.js';
import { evidenceCte, type PageQuery } from './repository.js';

// These are deliberately limited, versioned reviewer heuristics, not a probability or a grade.
export const evidencePolicy = {
  version: '1.0.0',
  baseWeightBasisPoints: 10000 as const,
  maxReductionBasisPoints: 3000,
  signals: [
    { code: 'window_changes', label: 'Уход из окна упражнения', reductionBasisPoints: 500 },
    { code: 'answer_paste', label: 'Вставка в ответ', reductionBasisPoints: 1500 },
    { code: 'pointer_pattern', label: 'Нетипичные события ввода', reductionBasisPoints: 1000 },
    {
      code: 'short_response_interval',
      label: 'Короткий интервал ответа',
      reductionBasisPoints: 500,
    },
  ],
};
export function evidenceWeight(codes: string[], assessed: boolean) {
  const unique = new Set(codes),
    known = assessed ? evidencePolicy.signals.filter((s) => unique.has(s.code)) : [],
    total = known.reduce((n, s) => n + s.reductionBasisPoints, 0),
    capped = Math.min(total, evidencePolicy.maxReductionBasisPoints),
    deductions = known.map((s) => ({
      ...s,
      reductionBasisPoints: total ? Math.floor((s.reductionBasisPoints * capped) / total) : 0,
    }));
  // Allocate rounding remainder so the visible contributions add up exactly to the cap.
  let remainder = capped - deductions.reduce((n, s) => n + s.reductionBasisPoints, 0);
  const order = known
    .map((s, i) => ({ i, fraction: total ? (s.reductionBasisPoints * capped) % total : 0 }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (const { i } of order)
    if (remainder > 0) {
      deductions[i]!.reductionBasisPoints++;
      remainder--;
    }
  return {
    weightBasisPoints: 10000 - capped,
    deductions,
    unknownSignalCodes: [...unique]
      .filter((code) => !evidencePolicy.signals.some((s) => s.code === code))
      .sort(),
  };
}
type Group = {
  package_id: string;
  package_version: number;
  skill_id: string;
  title: string;
  independent: boolean;
  correct: boolean;
  assessed: boolean;
  requires_review: boolean;
  codes: string[];
  total: number;
};
const hasDataSql = `(i.assessment IS NOT NULL AND i.assessment->>'status'<>'insufficient_data' AND COALESCE((i.assessment->>'packetCount')::integer,0)>0)`;
export async function integritySummary(tx: QueryExecutor, userId: string, language: string) {
  // Aggregate the complete history in SQL; never load every attempt into the API process.
  const groups = (
    await tx.query<Group>(
      `${evidenceCte}, weighted_groups AS (
    SELECT e.package_id,e.package_version,e.skill_id,k.definition->>'title' AS title,
      e.independent,e.correct,${hasDataSql} AS assessed,COALESCE(i.requires_review,false) AS requires_review,
      ARRAY(SELECT DISTINCT signal->>'code' FROM jsonb_array_elements(COALESCE(i.assessment->'signals','[]'::jsonb)) signal ORDER BY signal->>'code') AS codes
      FROM evidence e LEFT JOIN engine_integrity_assessments i ON i.attempt_id=e.id
      JOIN learning_skills k ON k.package_id=e.package_id AND k.package_version=e.package_version AND k.id=e.skill_id WHERE e.released
    ) SELECT package_id,package_version,skill_id,title,independent,correct,assessed,requires_review,codes,count(*)::integer AS total
    FROM weighted_groups GROUP BY package_id,package_version,skill_id,title,independent,correct,assessed,requires_review,codes
    ORDER BY package_id,package_version,skill_id`,
      [userId, language],
    )
  ).rows;
  let assessedAttempts = 0,
    insufficientDataAttempts = 0,
    flaggedAttempts = 0,
    requiresReviewAttempts = 0,
    independentCorrect = 0,
    independentCorrectWithoutData = 0,
    weightedBasisPoints = 0;
  const signalImpact = evidencePolicy.signals.map((s) => ({
      ...s,
      attempts: 0,
      independentCorrectAffected: 0,
      evidenceReductionBasisPoints: 0,
    })),
    skills = new Map<
      string,
      {
        packageId: string;
        packageVersion: number;
        skillId: string;
        title: string;
        independentCorrect: number;
        weighted: number;
        insufficientDataAttempts: number;
        requiresReviewAttempts: number;
      }
    >();
  for (const g of groups) {
    const key = JSON.stringify([g.package_id, g.package_version, g.skill_id]),
      skill = skills.get(key) ?? {
        packageId: g.package_id,
        packageVersion: g.package_version,
        skillId: g.skill_id,
        title: g.title,
        independentCorrect: 0,
        weighted: 0,
        insufficientDataAttempts: 0,
        requiresReviewAttempts: 0,
      };
    skills.set(key, skill);
    assessedAttempts += g.assessed ? g.total : 0;
    insufficientDataAttempts += !g.assessed ? g.total : 0;
    flaggedAttempts += g.assessed && g.codes.length > 0 ? g.total : 0;
    requiresReviewAttempts += g.requires_review ? g.total : 0;
    skill.insufficientDataAttempts += !g.assessed ? g.total : 0;
    skill.requiresReviewAttempts += g.requires_review ? g.total : 0;
    const weight = evidenceWeight(g.codes, g.assessed),
      success = g.independent && g.correct;
    if (success) {
      independentCorrect += g.total;
      skill.independentCorrect += g.total;
      independentCorrectWithoutData += !g.assessed ? g.total : 0;
      weightedBasisPoints += weight.weightBasisPoints * g.total;
      skill.weighted += weight.weightBasisPoints * g.total;
    }
    for (const d of weight.deductions) {
      const impact = signalImpact.find((s) => s.code === d.code)!;
      impact.attempts += g.total;
      if (success) {
        impact.independentCorrectAffected += g.total;
        impact.evidenceReductionBasisPoints += d.reductionBasisPoints * g.total;
      }
    }
  }
  return {
    version: evidencePolicy.version,
    policy: {
      baseWeightBasisPoints: evidencePolicy.baseWeightBasisPoints,
      maxReductionBasisPoints: evidencePolicy.maxReductionBasisPoints,
      signals: evidencePolicy.signals,
    },
    assessedAttempts,
    insufficientDataAttempts,
    flaggedAttempts,
    requiresReviewAttempts,
    independentCorrect,
    independentCorrectWithoutData,
    weightedEvidenceUnits: weightedBasisPoints / 10000,
    evidenceReductionUnits: (independentCorrect * 10000 - weightedBasisPoints) / 10000,
    signalImpact,
    skills: [...skills.values()].map(({ weighted, ...s }) => ({
      ...s,
      weightedEvidenceUnits: weighted / 10000,
      evidenceReductionUnits: (s.independentCorrect * 10000 - weighted) / 10000,
    })),
  };
}
export async function integrityPage(tx: QueryExecutor, userId: string, input: PageQuery) {
  const rows = (
    await tx.query(
      `${evidenceCte} SELECT e.*,k.definition->>'title' AS skill_title,i.assessment,${hasDataSql} AS assessed
    FROM evidence e JOIN engine_integrity_assessments i ON i.attempt_id=e.id
    JOIN learning_skills k ON k.package_id=e.package_id AND k.package_version=e.package_version AND k.id=e.skill_id
    WHERE e.released AND jsonb_array_length(i.assessment->'signals')>0
      AND ($3::timestamptz IS NULL OR (e.evaluated_at,e.id)<($3,$4::uuid))
    ORDER BY e.evaluated_at DESC,e.id DESC LIMIT $5`,
      [
        userId,
        input.language,
        input.beforeCreatedAt ?? null,
        input.beforeId ?? null,
        input.limit + 1,
      ],
    )
  ).rows;
  const items = rows.slice(0, input.limit).map((r) => {
    const assessment = integrityAssessmentSchema.parse(r.assessment),
      weight = evidenceWeight(
        assessment.signals.map((s) => s.code),
        Boolean(r.assessed),
      );
    return reportIntegrityAttemptSchema.parse({
      id: r.id,
      runId: r.run_id,
      runTitle: r.run_title,
      evaluatedAt: iso(r.evaluated_at as string),
      skillTitle: r.skill_title,
      independent: r.independent,
      correct: r.correct,
      teacherReviewed: r.teacher_correct !== null,
      assessment,
      ...weight,
      evidenceReductionBasisPoints:
        r.independent && r.correct ? 10000 - weight.weightBasisPoints : 0,
    });
  });
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > input.limit && last ? { createdAt: last.evaluatedAt, id: last.id } : null,
  };
}
export async function reviewerReport(tx: QueryExecutor, userId: string, language: 'ru' | 'en') {
  return reportIntegritySchema.parse({
    ...(await integritySummary(tx, userId, language)),
    attempts: await integrityPage(tx, userId, { language, limit: 20 }),
  });
}
