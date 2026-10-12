import { z } from 'zod';
const count = z.number().int().min(0).max(10000).default(0);
export const integrityStatsSchema = z
  .strictObject({
    durationMilliseconds: z.number().int().min(0).max(300000),
    hiddenMilliseconds: z.number().int().min(0).max(300000).default(0),
    tabHides: count,
    focusLosses: count,
    returns: count,
    pointerSamples: count,
    pointerDistance: z.number().int().min(0).max(10000000).default(0),
    fastMoves: count,
    straightMoves: count,
    syntheticEvents: count,
    pointerTypes: z
      .array(z.enum(['mouse', 'touch', 'pen']))
      .max(3)
      .default([]),
    keyboardNavigation: z.boolean().default(false),
    inputEvents: count,
    pasteEvents: count,
    copyEvents: count,
  })
  .refine(
    (stats) =>
      stats.hiddenMilliseconds <= stats.durationMilliseconds &&
      stats.fastMoves <= stats.pointerSamples &&
      stats.straightMoves <= stats.pointerSamples,
    'Inconsistent observations.',
  );
export const integrityPacketSchema = z.strictObject({
  turnId: z.uuid(),
  batchId: z.uuid(),
  stats: integrityStatsSchema,
});
export const integrityAckSchema = z.object({ accepted: z.boolean(), monitored: z.boolean() });
export const integrityPolicySchema = z.strictObject({ enabled: z.boolean() });
export const integrityAssessmentSchema = z.object({
  status: z.enum(['insufficient_data', 'no_concerns', 'review']),
  requiresReview: z.boolean(),
  assessorVersion: z.string(),
  evaluatedAt: z.iso.datetime(),
  signals: z.array(
    z.object({
      code: z.string(),
      label: z.string(),
      source: z.enum(['browser', 'server']),
      context: z.string(),
    }),
  ),
  packetCount: z.number().int().nonnegative(),
  stats: integrityStatsSchema.safeExtend({
    durationMilliseconds: z.number().int().nonnegative(),
    hiddenMilliseconds: z.number().int().nonnegative(),
    pointerDistance: z.number().int().nonnegative(),
    pointerSamples: z.number().int().nonnegative(),
    fastMoves: z.number().int().nonnegative(),
    straightMoves: z.number().int().nonnegative(),
    syntheticEvents: z.number().int().nonnegative(),
    inputEvents: z.number().int().nonnegative(),
    pasteEvents: z.number().int().nonnegative(),
    copyEvents: z.number().int().nonnegative(),
    tabHides: z.number().int().nonnegative(),
    focusLosses: z.number().int().nonnegative(),
    returns: z.number().int().nonnegative(),
  }),
});
export type IntegrityStats = z.infer<typeof integrityStatsSchema>;
export type IntegrityPacket = z.infer<typeof integrityPacketSchema>;
export type IntegrityAssessment = z.infer<typeof integrityAssessmentSchema>;
