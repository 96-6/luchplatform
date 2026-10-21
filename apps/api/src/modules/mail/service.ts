import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Settings } from '../../config.js';
import type { Database, QueryExecutor } from '../../db/database.js';
import { AppError } from '../../errors.js';
import { AccountCrypto } from '../auth/crypto.js';

export class MailService {
  constructor(
    private readonly database: Database,
    private readonly settings: Settings,
    private readonly crypto: AccountCrypto,
  ) {}
  async queue(
    tx: QueryExecutor,
    userId: string,
    email: string,
    verificationToken: string,
    purpose: 'email' | 'password' = 'email',
  ) {
    const verificationUrl = `${this.settings.APP_URL}/${purpose === 'password' ? 'set-password' : 'verify-email'}?token=${verificationToken}`;
    const message = {
      verificationUrl,
      text: `${purpose === 'password' ? 'Установите новый пароль ЛУЧ' : 'Подтвердите почту ЛУЧ'}: ${verificationUrl}\nЕсли вы не создавали аккаунт, не переходите по ссылке.`,
    };
    const id = randomUUID();
    await tx.query(
      'INSERT INTO mail_outbox (id,user_id,recipient,subject,body_ciphertext) VALUES ($1,$2,$3,$4,$5)',
      [
        id,
        userId,
        email,
        purpose === 'password' ? 'ЛУЧ: установка пароля' : 'ЛУЧ: подтверждение почты',
        this.crypto.encrypt(JSON.stringify(message)),
      ],
    );
    return id;
  }
  async send(id: string) {
    if (this.settings.MAIL_MODE === 'local') return;
    const result = await this.database.query<{
      recipient: string;
      subject: string;
      body_ciphertext: string;
    }>(
      'SELECT recipient,subject,body_ciphertext FROM mail_outbox WHERE id=$1 AND sent_at IS NULL',
      [id],
    );
    const row = result.rows[0];
    if (!row) return;
    const transport = nodemailer.createTransport({
      host: this.settings.SMTP_HOST,
      port: this.settings.SMTP_PORT,
      secure: this.settings.SMTP_SECURE,
      requireTLS: !this.settings.SMTP_SECURE,
      connectionTimeout: 5000,
      socketTimeout: 8000,
      ...(this.settings.SMTP_USER
        ? { auth: { user: this.settings.SMTP_USER, pass: this.settings.SMTP_PASSWORD } }
        : {}),
    });
    try {
      const body = JSON.parse(this.crypto.decrypt(row.body_ciphertext)) as { text: string };
      await transport.sendMail({
        from: this.settings.SMTP_FROM,
        to: row.recipient,
        subject: row.subject,
        text: body.text,
      });
      await this.database.query('UPDATE mail_outbox SET sent_at=now() WHERE id=$1', [id]);
    } catch {
      throw new AppError(
        503,
        'MAIL_UNAVAILABLE',
        'Почтовый сервис временно недоступен. Повторите регистрацию позже.',
      );
    } finally {
      transport.close();
    }
  }
  async localInbox(email: string) {
    const result = await this.database.query<{
      id: string;
      subject: string;
      body_ciphertext: string;
      created_at: Date;
    }>(
      'SELECT id,subject,body_ciphertext,created_at FROM mail_outbox WHERE recipient=$1 ORDER BY created_at DESC LIMIT 5',
      [email.toLowerCase()],
    );
    return result.rows.map((row) => ({
      id: row.id,
      subject: row.subject,
      ...JSON.parse(this.crypto.decrypt(row.body_ciphertext)),
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }
}
