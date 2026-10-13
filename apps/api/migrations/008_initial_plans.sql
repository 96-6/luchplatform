ALTER TABLE diagnostic_sessions ADD CONSTRAINT diagnostic_plan_source
  UNIQUE (id,user_id,package_id,package_version,route_id);
ALTER TABLE learning_lessons ADD CONSTRAINT learning_lesson_route
  UNIQUE (package_id,package_version,id,route_id);
ALTER TABLE engine_runs ADD CONSTRAINT engine_plan_source
  UNIQUE (id,user_id,package_id,package_version,lesson_id,purpose);

CREATE TABLE learning_plans (
  id uuid PRIMARY KEY,
  diagnostic_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  package_id text NOT NULL,
  package_version integer NOT NULL,
  route_id text NOT NULL,
  rules_version text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  UNIQUE (id,user_id,package_id,package_version,route_id),
  FOREIGN KEY (diagnostic_id,user_id,package_id,package_version,route_id)
    REFERENCES diagnostic_sessions(id,user_id,package_id,package_version,route_id)
);
CREATE INDEX learning_plans_user ON learning_plans(user_id,created_at DESC,id DESC);

CREATE TABLE plan_assignments (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL,
  user_id uuid NOT NULL,
  package_id text NOT NULL,
  package_version integer NOT NULL,
  route_id text NOT NULL,
  lesson_id text NOT NULL,
  purpose text NOT NULL DEFAULT 'practice' CHECK (purpose='practice'),
  position integer NOT NULL CHECK (position>=0),
  recommended_day integer NOT NULL CHECK (recommended_day>0),
  estimated_minutes integer NOT NULL CHECK (estimated_minutes>0),
  reason jsonb NOT NULL CHECK (jsonb_typeof(reason)='object'),
  run_id uuid,
  started_by uuid REFERENCES users(id),
  started_at timestamptz,
  UNIQUE (plan_id,position),
  UNIQUE (plan_id,lesson_id),
  UNIQUE (id,package_id,package_version),
  FOREIGN KEY (plan_id,user_id,package_id,package_version,route_id)
    REFERENCES learning_plans(id,user_id,package_id,package_version,route_id),
  FOREIGN KEY (package_id,package_version,lesson_id,route_id)
    REFERENCES learning_lessons(package_id,package_version,id,route_id),
  FOREIGN KEY (run_id,user_id,package_id,package_version,lesson_id,purpose)
    REFERENCES engine_runs(id,user_id,package_id,package_version,lesson_id,purpose),
  CHECK ((run_id IS NULL AND started_by IS NULL AND started_at IS NULL) OR
    (run_id IS NOT NULL AND started_by IS NOT NULL AND started_at IS NOT NULL))
);
CREATE INDEX plan_assignments_run ON plan_assignments(run_id) WHERE run_id IS NOT NULL;
CREATE TABLE plan_assignment_exercises (
  assignment_id uuid NOT NULL,
  package_id text NOT NULL,
  package_version integer NOT NULL,
  exercise_id text NOT NULL,
  exercise_version integer NOT NULL,
  position integer NOT NULL CHECK (position>=0),
  PRIMARY KEY (assignment_id,position),
  UNIQUE (assignment_id,exercise_id),
  FOREIGN KEY (assignment_id,package_id,package_version)
    REFERENCES plan_assignments(id,package_id,package_version),
  FOREIGN KEY (package_id,package_version,exercise_id,exercise_version)
    REFERENCES learning_exercises(package_id,package_version,id,exercise_version)
);
