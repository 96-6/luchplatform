import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Secret, TOTP } from 'otpauth';

export class AccountCrypto {
  private readonly key: Buffer;
  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');
    if (this.key.length !== 32) throw new Error('Account key missing. Run npm run setup.');
  }
  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
  }
  decrypt(value: string): string {
    const parts = value.split('.');
    if (parts.length !== 3) throw new Error('Invalid protected value');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(parts[0]!, 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[1]!, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[2]!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
  mac(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }
  matches(value: string, expected: string): boolean {
    const left = Buffer.from(value);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
export const token = () => randomBytes(32).toString('base64url');
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export function createTotp(email: string, secret = new Secret({ size: 20 }).base32) {
  return new TOTP({
    issuer: 'ЛУЧ',
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}
