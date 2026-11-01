import { z } from 'zod';

export const sourceCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const buildInfoSchema = z.object({
  version: z.string().max(80),
  commit: sourceCommitSchema.nullable(),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  builtAt: z.iso.datetime().nullable(),
  modified: z.boolean(),
  kind: z.enum(['build', 'development', 'unknown']),
});
export type BuildInfo = z.infer<typeof buildInfoSchema>;
export const updatePhaseSchema = z.enum([
  'queued',
  'fetching',
  'installing',
  'building',
  'waiting_for_meetings',
  'stopping',
  'backing_up',
  'migrating',
  'starting',
  'verifying',
  'rolling_back',
  'completed',
  'failed',
  'rollback_failed',
]);
export const updateJobSchema = z.object({
  id: z.uuid(),
  targetCommit: sourceCommitSchema,
  actorName: z.string().max(100),
  phase: updatePhaseSchema,
  createdAt: z.iso.datetime(),
  heartbeatAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  restored: z.boolean(),
  error: z.string().max(1500).nullable(),
  logs: z
    .array(
      z.object({
        sequence: z.number().int().nonnegative(),
        at: z.iso.datetime(),
        text: z.string().max(1500),
      }),
    )
    .max(1500),
});
export type UpdateJob = z.infer<typeof updateJobSchema>;
export const updaterAgentSchema = z.object({
  available: z.boolean(),
  mode: z.enum(['node', 'container']).nullable(),
  heartbeatAt: z.iso.datetime().nullable(),
  protocol: z.number().int().nullable(),
});
export const updateOverviewSchema = z.object({
  current: buildInfoSchema,
  repository: z.literal('96-6/luchplatform'),
  branch: z.literal('main'),
  status: z.enum(['unknown', 'current', 'outdated', 'different', 'ahead']),
  updateAvailable: z.boolean(),
  checking: z.boolean(),
  checkedAt: z.iso.datetime().nullable(),
  nextCheckAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
  latest: z
    .object({
      commit: sourceCommitSchema,
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      committedAt: z.iso.datetime(),
    })
    .nullable(),
  agent: updaterAgentSchema,
  canUpdate: z.boolean(),
  liveMeetings: z.number().int().nonnegative(),
  latestJob: updateJobSchema.nullable(),
  history: z
    .array(
      z.object({
        id: z.uuid(),
        targetCommit: sourceCommitSchema,
        actorName: z.string(),
        phase: updatePhaseSchema,
        createdAt: z.iso.datetime(),
        completedAt: z.iso.datetime().nullable(),
        restored: z.boolean(),
      }),
    )
    .max(20),
});
export type UpdateOverview = z.infer<typeof updateOverviewSchema>;
export const startUpdateSchema = z.strictObject({
  operationId: z.uuid(),
  targetCommit: sourceCommitSchema,
});
export const updateProgressSchema = z.object({
  job: updateJobSchema,
  transport: z.enum(['application', 'maintenance']),
});
export const systemStatusSchema = z.object({
  refreshedAt: z.iso.datetime(),
  uptimeSeconds: z.number().nonnegative(),
  memoryMb: z.number().nonnegative(),
  database: z.object({
    driver: z.enum(['embedded', 'postgres']),
    available: z.boolean(),
    schemaCurrent: z.boolean(),
    schemaVersion: z.string().nullable(),
    latencyMs: z.number().nonnegative(),
  }),
  build: buildInfoSchema,
  agent: updaterAgentSchema,
  video: z.object({ configured: z.boolean(), available: z.boolean().nullable() }),
  mail: z.enum(['local', 'smtp', 'not_configured']),
});
