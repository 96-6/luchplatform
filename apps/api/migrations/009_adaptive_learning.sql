CREATE TABLE adaptive_policy (
  id smallint PRIMARY KEY CHECK (id=1),
  installed_at timestamptz NOT NULL DEFAULT now(),
  review_delay_hours integer NOT NULL DEFAULT 48 CHECK (review_delay_hours BETWEEN 24 AND 336)
);
INSERT INTO adaptive_policy (id) VALUES (1);

CREATE TABLE student_skill_states (
  user_id uuid NOT NULL REFERENCES users(id),
  package_id text NOT NULL,
  package_version integer NOT NULL,
  skill_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
  independent_successes integer NOT NULL DEFAULT 0 CHECK (independent_successes>=0),
  hinted_successes integer NOT NULL DEFAULT 0 CHECK (hinted_successes>=0),
  assisted_successes integer NOT NULL DEFAULT 0 CHECK (assisted_successes>=0),
  mistakes integer NOT NULL DEFAULT 0 CHECK (mistakes>=0),
  diagnostic_attempts integer NOT NULL DEFAULT 0 CHECK (diagnostic_attempts>=0),
  control_attempts integer NOT NULL DEFAULT 0 CHECK (control_attempts>=0),
  independent_streak integer NOT NULL DEFAULT 0 CHECK (independent_streak>=0),
  status text NOT NULL DEFAULT 'learning' CHECK (status IN ('learning','needs_practice','supported','demonstrated','confirmed')),
  last_outcome text NOT NULL CHECK (last_outcome IN ('mistake','independent_success','hinted_success','assisted_success')),
  last_attempt_id uuid NOT NULL REFERENCES engine_attempts(id),
  last_observed_at timestamptz NOT NULL,
  last_independent_at timestamptz,
  last_review_at timestamptz,
  PRIMARY KEY (user_id,package_id,package_version,skill_id),
  FOREIGN KEY (package_id,package_version,skill_id) REFERENCES learning_skills(package_id,package_version,id),
  CHECK (attempts=independent_successes+hinted_successes+assisted_successes+mistakes)
);
CREATE TABLE skill_observations (
  attempt_id uuid PRIMARY KEY REFERENCES engine_attempts(id),
  user_id uuid NOT NULL,
  package_id text NOT NULL,
  package_version integer NOT NULL,
  skill_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('mistake','independent_success','hinted_success','assisted_success')),
  purpose text NOT NULL CHECK (purpose IN ('diagnostic','practice','control')),
  rules_version text NOT NULL,
  observed_at timestamptz NOT NULL,
  FOREIGN KEY (user_id,package_id,package_version,skill_id) REFERENCES student_skill_states(user_id,package_id,package_version,skill_id)
);

ALTER TABLE plan_assignments DROP CONSTRAINT plan_assignments_plan_id_lesson_id_key;
ALTER TABLE plan_assignments DROP CONSTRAINT plan_assignments_purpose_check;
ALTER TABLE plan_assignments ADD CONSTRAINT plan_assignment_purpose CHECK (purpose IN ('practice','control'));
ALTER TABLE plan_assignments ADD COLUMN kind text NOT NULL DEFAULT 'initial' CHECK (kind IN ('initial','correction','supported_practice','review'));
ALTER TABLE plan_assignments ADD COLUMN skill_id text;
ALTER TABLE plan_assignments ADD COLUMN source_attempt_id uuid REFERENCES engine_attempts(id);
ALTER TABLE plan_assignments ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE plan_assignments ADD COLUMN due_at timestamptz;
ALTER TABLE plan_assignments ADD COLUMN closed_at timestamptz;
ALTER TABLE plan_assignments ADD CONSTRAINT plan_assignment_skill FOREIGN KEY (package_id,package_version,skill_id)
  REFERENCES learning_skills(package_id,package_version,id);
ALTER TABLE plan_assignments ADD CONSTRAINT plan_assignment_owner UNIQUE (id,user_id,package_id,package_version);
ALTER TABLE plan_assignments ADD CONSTRAINT plan_adaptive_source UNIQUE (plan_id,source_attempt_id,kind);
CREATE UNIQUE INDEX plan_initial_lesson ON plan_assignments(plan_id,lesson_id) WHERE kind='initial';
CREATE UNIQUE INDEX plan_pending_skill ON plan_assignments(plan_id,skill_id,kind) WHERE kind<>'initial' AND closed_at IS NULL;
UPDATE plan_assignments a SET closed_at=r.completed_at FROM engine_runs r WHERE a.run_id=r.id AND r.status='completed';

ALTER TABLE engine_runs DROP CONSTRAINT engine_runs_source_type_check;
ALTER TABLE engine_runs DROP CONSTRAINT engine_runs_check;
ALTER TABLE engine_runs ADD COLUMN assignment_id uuid;
ALTER TABLE engine_runs ADD CONSTRAINT engine_assignment_owner FOREIGN KEY (assignment_id,user_id,package_id,package_version)
  REFERENCES plan_assignments(id,user_id,package_id,package_version);
ALTER TABLE engine_runs ADD CONSTRAINT engine_source_type CHECK (source_type IN ('lesson','set','assignment'));
ALTER TABLE engine_runs ADD CONSTRAINT engine_source_details CHECK (
  (source_type='lesson' AND lesson_id=source_id AND lesson_id IS NOT NULL AND set_id IS NULL AND assignment_id IS NULL) OR
  (source_type='set' AND set_id=source_id AND set_id IS NOT NULL AND lesson_id IS NULL AND assignment_id IS NULL) OR
  (source_type='assignment' AND source_id=assignment_id::text AND assignment_id IS NOT NULL AND lesson_id IS NOT NULL AND set_id IS NULL)
);

CREATE TABLE generated_exercises (
  id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL UNIQUE REFERENCES plan_assignments(id),
  package_id text NOT NULL,
  package_version integer NOT NULL,
  exercise_id text NOT NULL,
  exercise_version integer NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  provider text NOT NULL CHECK (provider IN ('openai','neuroapi')),
  model text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (id,package_id,package_version,exercise_id,exercise_version),
  FOREIGN KEY (package_id,package_version,exercise_id,exercise_version)
    REFERENCES learning_exercises(package_id,package_version,id,exercise_version)
);
ALTER TABLE engine_steps ADD COLUMN generated_exercise_id uuid;
ALTER TABLE engine_steps ADD CONSTRAINT engine_generated_exercise FOREIGN KEY (generated_exercise_id,package_id,package_version,exercise_id,exercise_version)
  REFERENCES generated_exercises(id,package_id,package_version,exercise_id,exercise_version);
ALTER TABLE plan_assignment_exercises ADD COLUMN generated_exercise_id uuid;
ALTER TABLE plan_assignment_exercises ADD CONSTRAINT plan_generated_exercise FOREIGN KEY (generated_exercise_id,package_id,package_version,exercise_id,exercise_version)
  REFERENCES generated_exercises(id,package_id,package_version,exercise_id,exercise_version);

CREATE TABLE learning_plan_changes (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES learning_plans(id),
  event_id uuid NOT NULL REFERENCES engine_events(id),
  assignment_id uuid REFERENCES plan_assignments(id),
  action text NOT NULL CHECK (action IN ('correction_added','correction_reused','supported_practice_added','supported_practice_reused','review_scheduled','review_reused','next_step_ready','review_confirmed','bank_unavailable')),
  skill_id text NOT NULL,
  outcome text NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (plan_id,event_id,action)
);
CREATE INDEX learning_plan_changes_page ON learning_plan_changes(plan_id,created_at DESC,id DESC);
CREATE INDEX engine_events_pending ON engine_events(created_at,id) WHERE processed_at IS NULL;
