import { z } from 'zod';
export * from './accounts.js';
export * from './content.js';
export * from './engine.js';
export * from './integrity.js';
export * from './diagnostics.js';
export * from './plans.js';

export const API_PREFIX = '/api/v1';
export const systemSchema = z.object({
  application: z.literal('ЛУЧ'),
  stage: z.enum(['foundation', 'accounts', 'content', 'engine', 'diagnostics', 'plans']),
  devToolsEnabled: z.boolean(),
});
export const healthSchema = z.object({ status: z.literal('ok') });
export const createProbeSchema = z.strictObject({
  label: z.string().trim().min(1, 'Введите текст записи').max(120, 'Не более 120 символов'),
  operationId: z.uuid(),
});
export const probeSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  operationId: z.uuid(),
  createdAt: z.iso.datetime(),
});
export const probesSchema = z.array(probeSchema);
export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    fields: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export function envelopeSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, requestId: z.string() });
}
export type SystemInfo = z.infer<typeof systemSchema>;
export type Probe = z.infer<typeof probeSchema>;
export type CreateProbe = z.infer<typeof createProbeSchema>;
