import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/config.js';

describe('environment validation', () => {
  it('uses durable local storage and disables development tools unless explicitly enabled', () => {
    const settings = parseSettings({});
    expect(settings.DATABASE_URL).toBe('pglite:./data/luch');
    expect(settings.ENABLE_DEV_TOOLS).toBe(false);
  });
  it.each([
    { API_PORT: 'NaN' },
    { DATABASE_URL: 'memory' },
    { DATABASE_URL: 'pglite:' },
    { DATABASE_URL: 'pglite:memory' },
    { APP_URL: 'https://luch.example/path' },
    { APP_URL: 'ftp://luch.example' },
    { ENABLE_DEV_TOOLS: 'yes' },
  ])('rejects invalid configuration %#', (environment) => {
    expect(() => parseSettings(environment)).toThrow('Invalid environment:');
  });
  it('requires PostgreSQL, HTTPS and disabled development tools in production', () => {
    expect(() => parseSettings({ APP_ENV: 'production', ENABLE_DEV_TOOLS: 'true' })).toThrow();
    expect(
      parseSettings({
        APP_ENV: 'production',
        APP_URL: 'https://luch.example',
        DATABASE_URL: 'postgresql://user:password@db:5432/luch',
        AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        MAIL_MODE: 'smtp',
        SMTP_HOST: 'smtp.example.test',
      }).ENABLE_DEV_TOOLS,
    ).toBe(false);
  });
  it('does not expose credential values in configuration errors', () => {
    try {
      parseSettings({ DATABASE_URL: 'unsafe-secret-123', API_PORT: 'broken' });
    } catch (error) {
      expect(String(error)).not.toContain('unsafe-secret-123');
    }
  });
});
