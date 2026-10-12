# LUCH development rules

Follow the user's numbered tasks in `docs/ROADMAP.md` from top to bottom. Complete subtasks in order, verify the stated acceptance result, and record evidence before starting the next task. This repository currently implements task 1 only.

- Read `README.md`, `docs/ARCHITECTURE.md`, and the current task's acceptance record before changes.
- Keep the React client, Fastify API, and shared validation contracts integrated. Only the server reads database credentials or provider keys.
- Persist application state in PostgreSQL. Never replace persistence with browser storage or mock responses for acceptance scenarios.
- Add new immutable SQL migrations. Do not edit an already applied migration; the runner checks its checksum and executes migrations in a transaction.
- Local PGlite uses the same PostgreSQL SQL as the hosted `pg` driver. Keep both supported, and verify changes against native PostgreSQL in CI.
- Add domain modules under `apps/api/src/modules`; separate routes, services, and persistence. Keep API envelopes and request IDs consistent.
- Authorization belongs on the server for every protected read/write. UI navigation does not grant access. Task 1 has no accounts or learning endpoints.
- When adding attempts and plan changes, use transaction boundaries and database uniqueness to make repeat deliveries safe. Keep the original answer and evaluation history.
- Leave assistant, speech, LMS and video providers behind server adapters. Do not treat a technical failure as a learning mistake.
- Update task status, run instructions, API documentation and acceptance evidence as the code changes. Do not mark an unrun check as passed.
- Relevant checks: `npm run format:check`, `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`; native PostgreSQL and Compose checks run in GitHub Actions.
- Never commit `.env`, database files, user answers, raw audio, access tokens or provider credentials. The Docker image excludes local environment files.
