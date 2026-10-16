# Зависимости

Точные версии и транзитивные зависимости зафиксированы в `package-lock.json`; установка — через `npm ci`. Основные компоненты:

| Компонент                               | Назначение                                       | Лицензия           |
| --------------------------------------- | ------------------------------------------------ | ------------------ |
| React / React DOM                       | Клиент                                           | MIT                |
| React Router                            | Навигация                                        | MIT                |
| Vite / React plugin                     | Сборка клиента                                   | MIT                |
| Fastify / Cors / Helmet / Static        | Сервер, заголовки и статика                      | MIT                |
| node-postgres (`pg`)                    | Сетевой доступ к PostgreSQL                      | MIT                |
| PGlite                                  | PostgreSQL для локальной разработки и тестов     | Apache-2.0         |
| LiveKit server / SDK / React components | Собственная видеосвязь WebRTC, медиа и модерация | Apache-2.0         |
| PostgreSQL                              | Сервер базы                                      | PostgreSQL License |
| Zod                                     | Проверка данных                                  | MIT                |
| proper-lockfile                         | Защита локального каталога базы                  | MIT                |
| dotenv                                  | Чтение серверного окружения                      | BSD-2-Clause       |
| TypeScript / tsx                        | Типы и запуск исходного сервера                  | Apache-2.0 / MIT   |
| Vitest / Playwright                     | Проверки API и браузера                          | MIT / Apache-2.0   |

Лицензии сторонних компонентов сохраняются в установленных пакетах. Наличие публичного репозитория само по себе не задаёт лицензию на собственный код ЛУЧ; отдельная открытая лицензия на него здесь не добавлена.

Документация для развития: [Fastify](https://fastify.dev/docs/latest/), [Vite](https://vite.dev/guide/), [PGlite](https://pglite.dev/docs/), [node-postgres](https://node-postgres.com/apis/pool), [PostgreSQL](https://www.postgresql.org/docs/).

Для аккаунтов добавлены OTPAuth, QRCode, Nodemailer, Fastify Cookie, ipaddr.js (MIT) и NAPI Canvas (MIT).

SMTP и дополнительные сетевые данные требуют настроенных серверных подключений. В задаче 1 отсутствуют платные внешние вызовы. Выбор ИИ, речи, видеосервиса и условия их использования фиксируются при интеграции, вместе с передаваемыми полями и ограничениями.
