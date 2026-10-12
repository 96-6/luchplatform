ALTER TABLE learning_exercises ADD CONSTRAINT learning_exercise_revision
  UNIQUE (package_id, package_version, id, exercise_version);

CREATE TABLE engine_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  package_id text NOT NULL,
  package_version integer NOT NULL,
  route_id text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('lesson','set')),
  source_id text NOT NULL,
  lesson_id text,
  set_id text,
  purpose text NOT NULL CHECK (purpose IN ('diagnostic','practice','control')),
  title text NOT NULL,
  is_demo boolean NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  current_position integer NOT NULL DEFAULT 0 CHECK (current_position >= 0),
  total_steps integer NOT NULL CHECK (total_steps > 0),
  cycle integer NOT NULL DEFAULT 1 CHECK (cycle > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (user_id, package_id, package_version, source_type, source_id, purpose, cycle),
  UNIQUE (id, package_id, package_version),
  UNIQUE (id, user_id),
  FOREIGN KEY (package_id, package_version, route_id) REFERENCES learning_routes(package_id, package_version, id),
  FOREIGN KEY (package_id, package_version, lesson_id) REFERENCES learning_lessons(package_id, package_version, id),
  FOREIGN KEY (package_id, package_version, set_id) REFERENCES learning_sets(package_id, package_version, id),
  CHECK ((source_type='lesson' AND lesson_id IS NOT NULL AND lesson_id=source_id AND set_id IS NULL) OR (source_type='set' AND set_id IS NOT NULL AND set_id=source_id AND lesson_id IS NULL)),
  CHECK ((status='active' AND current_position < total_steps AND completed_at IS NULL) OR (status='completed' AND current_position=total_steps AND completed_at IS NOT NULL))
);
CREATE INDEX engine_runs_user ON engine_runs(user_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX engine_one_active_run ON engine_runs(user_id, package_id, package_version, source_type, source_id, purpose) WHERE status='active';

CREATE TABLE engine_steps (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  package_id text NOT NULL,
  package_version integer NOT NULL,
  exercise_id text NOT NULL,
  exercise_version integer NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','current','completed')),
  current_turn_id uuid,
  UNIQUE (run_id, position),
  UNIQUE (run_id, id),
  FOREIGN KEY (run_id, package_id, package_version) REFERENCES engine_runs(id, package_id, package_version),
  FOREIGN KEY (package_id, package_version, exercise_id, exercise_version) REFERENCES learning_exercises(package_id, package_version, id, exercise_version)
);
CREATE TABLE engine_turns (
  id uuid PRIMARY KEY,
  step_id uuid NOT NULL REFERENCES engine_steps(id),
  number integer NOT NULL CHECK (number > 0),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','answered')),
  draft_answer jsonb,
  draft_revision bigint NOT NULL DEFAULT 0 CHECK (draft_revision >= 0),
  used_hints jsonb NOT NULL DEFAULT '[]'::jsonb,
  prior_feedback boolean NOT NULL DEFAULT false,
  admin_assistance boolean NOT NULL DEFAULT false,
  active_ms bigint NOT NULL DEFAULT 0 CHECK (active_ms >= 0),
  resumed boolean NOT NULL DEFAULT true,
  started_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (step_id, number),
  UNIQUE (step_id, id),
  CHECK (jsonb_typeof(used_hints)='array')
);
ALTER TABLE engine_steps ADD CONSTRAINT engine_current_turn
  FOREIGN KEY (id, current_turn_id) REFERENCES engine_turns(step_id, id);

CREATE TABLE engine_attempts (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL,
  step_id uuid NOT NULL,
  turn_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  answer jsonb NOT NULL,
  evaluation jsonb NOT NULL,
  is_correct boolean NOT NULL,
  independent boolean NOT NULL,
  used_hints jsonb NOT NULL,
  prior_feedback boolean NOT NULL,
  admin_assistance boolean NOT NULL,
  active_ms bigint NOT NULL CHECK (active_ms >= 0),
  elapsed_ms bigint NOT NULL CHECK (elapsed_ms >= 0),
  started_at timestamptz NOT NULL,
  evaluated_at timestamptz NOT NULL,
  UNIQUE (user_id, operation_id),
  FOREIGN KEY (run_id, user_id) REFERENCES engine_runs(id, user_id),
  FOREIGN KEY (run_id, step_id) REFERENCES engine_steps(run_id, id),
  FOREIGN KEY (step_id, turn_id) REFERENCES engine_turns(step_id, id),
  CHECK (is_correct=(evaluation->>'correct')::boolean)
);
CREATE INDEX engine_attempts_run ON engine_attempts(run_id, evaluated_at, id);
CREATE INDEX engine_attempts_user ON engine_attempts(user_id, evaluated_at DESC);

CREATE TABLE engine_events (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE REFERENCES engine_attempts(id),
  kind text NOT NULL CHECK (kind='exercise.answered'),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  processed_at timestamptz
);
