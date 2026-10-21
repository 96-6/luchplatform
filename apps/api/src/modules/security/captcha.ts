import { randomInt, randomUUID } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import type { z } from 'zod';
import { captchaInputSchema } from '@luch/contracts';
import type { Database } from '../../db/database.js';
import { AppError } from '../../errors.js';
import type { AccountCrypto } from '../auth/crypto.js';
import { limitAttempts } from './rate.js';
import { getPolicy } from './policy.js';

export type CaptchaPurpose = 'login' | 'register' | 'enrollment' | 'password';
export class CaptchaService {
  constructor(
    private readonly database: Database,
    private readonly crypto: AccountCrypto,
    private readonly generate = () =>
      Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(31)]).join(''),
  ) {}
  async issue(ip: string, purpose: CaptchaPurpose) {
    await limitAttempts(this.database, this.crypto, `captcha-issue:${ip}`, 60);
    const answer = this.generate();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const canvas = createCanvas(240, 82);
    const context = canvas.getContext('2d');
    context.fillStyle = '#edf4ed';
    context.fillRect(0, 0, 240, 82);
    for (let i = 0; i < 50; i++) {
      context.fillStyle = ['#8caea4', '#d5b579', '#c6d8c9'][randomInt(3)]!;
      context.beginPath();
      context.arc(randomInt(240), randomInt(82), randomInt(1, 3), 0, Math.PI * 2);
      context.fill();
    }
    for (let i = 0; i < answer.length; i++) {
      context.save();
      context.translate(29 + i * 42, randomInt(45, 62));
      context.rotate(((randomInt(31) - 15) * Math.PI) / 180);
      context.font = 'bold 36px sans-serif';
      context.fillStyle = ['#184e45', '#244d63', '#59481d'][randomInt(3)]!;
      context.fillText(answer[i]!, 0, 0);
      context.restore();
    }
    for (let i = 0; i < 3; i++) {
      context.strokeStyle = '#86a996';
      context.beginPath();
      context.moveTo(0, randomInt(82));
      context.bezierCurveTo(80, randomInt(82), 160, randomInt(82), 240, randomInt(82));
      context.stroke();
    }
    await this.database.query(
      'INSERT INTO captcha_challenges (id, answer_hash, ip_hash, purpose, expires_at) VALUES ($1,$2,$3,$4,$5)',
      [id, this.crypto.mac(`${id}:${answer}`), this.crypto.mac(ip), purpose, expiresAt],
    );
    await this.database.query('DELETE FROM captcha_challenges WHERE expires_at < $1', [new Date()]);
    return {
      id,
      imageDataUrl: `data:image/png;base64,${(await canvas.encode('png')).toString('base64')}`,
      expiresAt: expiresAt.toISOString(),
    };
  }
  async check(
    ip: string,
    purpose: CaptchaPurpose,
    input: z.infer<typeof captchaInputSchema> | undefined,
  ) {
    if (!(await getPolicy(this.database)).captchaEnabled) return;
    if (!input) throw new AppError(400, 'CAPTCHA_REQUIRED', 'Введите символы с картинки.');
    const result = await this.database.query<{
      answer_hash: string;
      ip_hash: string;
      purpose: string;
      expires_at: Date;
    }>('DELETE FROM captcha_challenges WHERE id = $1 RETURNING *', [input.id]);
    const row = result.rows[0];
    if (
      !row ||
      row.purpose !== purpose ||
      row.ip_hash !== this.crypto.mac(ip) ||
      new Date(row.expires_at).getTime() <= Date.now() ||
      !this.crypto.matches(
        this.crypto.mac(`${input.id}:${input.answer.toUpperCase()}`),
        row.answer_hash,
      )
    ) {
      throw new AppError(
        400,
        'CAPTCHA_INVALID',
        'Капча неверна или устарела. Получите новую картинку.',
      );
    }
  }
}
