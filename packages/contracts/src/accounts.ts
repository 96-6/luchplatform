import { z } from 'zod';

export const roleSchema = z.enum(['student', 'teacher', 'admin', 'superadmin']);
export const userSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  role: roleSchema,
  isDemo: z.boolean(),
  isBlocked: z.boolean(),
  isActive: z.boolean(),
  blockReason: z.string(),
  accessVerified: z.boolean(),
  emailVerified: z.boolean(),
  authenticatorEnabled: z.boolean(),
  passwordConfigured: z.boolean(),
  teacherApprovalPending: z.boolean().default(false),
  createdAt: z.iso.datetime(),
});
export const sessionSchema = z.object({
  user: userSchema.nullable(),
  csrfToken: z.string().nullable(),
  dashboardPath: z.string().nullable(),
});
export const captchaInputSchema = z.strictObject({
  id: z.uuid(),
  answer: z.string().trim().min(1).max(10),
});
export const captchaSchema = z.object({
  id: z.uuid(),
  imageDataUrl: z.string().startsWith('data:image/png;base64,'),
  expiresAt: z.iso.datetime(),
});
export const registerSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  name: z.string().trim().min(2).max(100),
  role: z.enum(['student', 'teacher']),
  password: z
    .string()
    .min(12, 'Пароль должен содержать не менее 12 символов.')
    .max(128, 'Пароль должен содержать не более 128 символов.'),
  captcha: captchaInputSchema.optional(),
});
export const loginSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(1).max(128),
  captcha: captchaInputSchema.optional(),
});
export const passwordSchema = registerSchema.shape.password;
export const loginStepSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('totp'), csrfToken: z.string(), expiresAt: z.iso.datetime() }),
  z.object({ step: z.literal('enrollment') }),
]);
export const loginResponseSchema = z.union([loginStepSchema, sessionSchema]);
export const loginChallengeSchema = loginStepSchema.nullable();
export const loginConfirmSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
export const passwordRequestSchema = z.strictObject({
  email: registerSchema.shape.email,
  captcha: captchaInputSchema.optional(),
});
export const passwordResetSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: passwordSchema,
});
export const passwordChangeSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  password: passwordSchema,
  code: z.string().regex(/^\d{6}$/),
});
export const adminPasswordResetSchema = z.strictObject({
  operationId: z.uuid(),
  password: passwordSchema,
});
export const enrollmentConfirmSchema = z.strictObject({
  code: z.string().regex(/^\d{6}$/),
  captcha: captchaInputSchema.optional(),
});
export const verificationSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const enrollmentSchema = z.object({
  email: z.email(),
  manualKey: z.string(),
  qrDataUrl: z.string().startsWith('data:image/png;base64,'),
  expiresAt: z.iso.datetime(),
});
export const completionSchema = z.object({
  session: sessionSchema,
  awaitingReview: z.boolean(),
  reviewReason: z.enum(['network', 'teacher_approval']).nullable().default(null),
});
export const messageSchema = z.object({ message: z.string() });
export const probeTargetSchema = z.object({
  id: z.enum(['youtube', 'telegram', 'whatsapp']),
  url: z.url(),
});
export const authPolicySchema = z.object({
  captchaEnabled: z.boolean(),
  localMailboxEnabled: z.boolean(),
  networkChecksEnabled: z.boolean(),
  probeTargets: z.array(probeTargetSchema),
  stunUrls: z.array(z.string()),
});
export const networkEvidenceSchema = z.strictObject({
  timezone: z.string().max(80).optional(),
  timezoneOffset: z.number().min(-900).max(900).optional(),
  resourceResults: z
    .array(z.strictObject({ id: probeTargetSchema.shape.id, loaded: z.boolean() }))
    .max(3)
    .optional(),
  latencyMs: z.array(z.number().min(0).max(30000)).max(2).optional(),
  webrtcIp: z.string().max(64).optional(),
  turboMode: z.boolean().optional(),
  jsProxyHint: z.boolean().optional(),
});
export const networkAccessSchema = z.object({
  allowed: z.boolean(),
  message: z.string().nullable(),
});
export const securityPolicySchema = z.strictObject({
  captchaEnabled: z.boolean(),
  vpnCheckEnabled: z.boolean(),
  ipAllowlist: z.array(z.string().trim().min(3).max(64)).max(100),
  sessionHours: z.number().int().min(1).max(168),
  revision: z.number().int().positive(),
});
export const securitySettingsSchema = securityPolicySchema.extend({ currentIp: z.string() });
export const usersSchema = z.array(userSchema);
export const accountUpdateSchema = z
  .strictObject({
    isBlocked: z.boolean(),
    isActive: z.boolean().optional(),
    blockReason: z.string().trim().max(1000).optional(),
    accessVerified: z.boolean(),
  })
  .refine((input) => input.isActive !== false || !input.isBlocked, {
    path: ['isBlocked'],
    message: 'Выберите деактивацию или блокировку.',
  });
export const adminAccountCreateSchema = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  name: z.string().trim().min(2).max(100),
  role: roleSchema,
  operationId: z.uuid(),
  password: passwordSchema,
});
export const adminAuthenticatorResetSchema = z.strictObject({ operationId: z.uuid() });
export const accountAuthenticatorSchema = z.object({
  user: userSchema,
  manualKey: z.string(),
  qrDataUrl: z.string().startsWith('data:image/png;base64,'),
  activatedAt: z.iso.datetime().nullable(),
});
export const teacherLinkSchema = z.strictObject({ teacherId: z.uuid(), studentId: z.uuid() });
export const observationSchema = z.object({
  label: z.string(),
  status: z.enum(['observed', 'not_observed', 'unknown']),
  source: z.enum(['server', 'client', 'provider']),
  strength: z.enum(['weak', 'supporting']),
});
export const assessmentSchema = z.object({
  id: z.uuid(),
  ip: z.string(),
  denied: z.boolean(),
  observations: z.array(observationSchema),
  createdAt: z.iso.datetime(),
});
export const learningProgressSchema = z.object({
  runs: z.number().int().nonnegative(),
  completedRuns: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  correctAttempts: z.number().int().nonnegative(),
  assistedAttempts: z.number().int().nonnegative(),
});
export const accountDetailSchema = z.object({
  user: userSchema,
  teachers: usersSchema,
  students: usersSchema,
  progress: learningProgressSchema,
  assessments: z.array(assessmentSchema),
  teacherApproval: z
    .object({
      pending: z.boolean(),
      approvedAt: z.iso.datetime().nullable(),
      approvedBy: z.object({ id: z.uuid(), name: z.string(), email: z.email() }).nullable(),
    })
    .nullable()
    .default(null),
});
export const mailSchema = z.array(
  z.object({
    id: z.uuid(),
    subject: z.string(),
    text: z.string(),
    verificationUrl: z.url(),
    createdAt: z.iso.datetime(),
  }),
);
export const auditSchema = z.array(
  z.object({
    id: z.uuid(),
    action: z.string(),
    actorEmail: z.string().nullable(),
    targetEmail: z.string().nullable(),
    createdAt: z.iso.datetime(),
  }),
);
export type User = z.infer<typeof userSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type SecurityPolicy = z.infer<typeof securityPolicySchema>;
export type NetworkEvidence = z.infer<typeof networkEvidenceSchema>;
export type Observation = z.infer<typeof observationSchema>;
