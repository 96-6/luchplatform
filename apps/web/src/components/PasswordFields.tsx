import { t } from '../i18n';

export function PasswordFields({
  prefix,
  password,
  confirmation,
  setPassword,
  setConfirmation,
}: {
  prefix: string;
  password: string;
  confirmation: string;
  setPassword: (value: string) => void;
  setConfirmation: (value: string) => void;
}) {
  return (
    <>
      <label htmlFor={`${prefix}-password`}>{t('Новый пароль')}</label>
      <input
        id={`${prefix}-password`}
        type="password"
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        aria-describedby={`${prefix}-password-help`}
      />
      <p className="muted" id={`${prefix}-password-help`}>
        {t('От 12 до 128 символов. Можно использовать длинную фразу и менеджер паролей.')}
      </p>
      <label htmlFor={`${prefix}-confirmation`}>{t('Повторите новый пароль')}</label>
      <input
        id={`${prefix}-confirmation`}
        type="password"
        autoComplete="new-password"
        minLength={12}
        maxLength={128}
        required
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
      />
    </>
  );
}
