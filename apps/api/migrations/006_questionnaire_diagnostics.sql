CREATE TABLE student_profiles (
  user_id uuid PRIMARY KEY,
  user_role varchar(20) NOT NULL DEFAULT 'student' CHECK (user_role='student'),
  revision integer NOT NULL CHECK (revision>0),
  questionnaire jsonb NOT NULL CHECK (jsonb_typeof(questionnaire)='object'),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (user_id,user_role) REFERENCES users(id,role)
);
CREATE TABLE student_profile_revisions (
  user_id uuid NOT NULL REFERENCES student_profiles(user_id),
  revision integer NOT NULL CHECK (revision>0),
  questionnaire jsonb NOT NULL CHECK (jsonb_typeof(questionnaire)='object'),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id,revision)
);
CREATE TABLE diagnostic_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES student_profiles(user_id),
  profile_revision integer NOT NULL,
  questionnaire jsonb NOT NULL,
  run_id uuid NOT NULL UNIQUE,
  package_id text NOT NULL,
  package_version integer NOT NULL,
  route_id text NOT NULL,
  set_id text NOT NULL,
  result jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  FOREIGN KEY (user_id,profile_revision) REFERENCES student_profile_revisions(user_id,revision),
  FOREIGN KEY (run_id,user_id) REFERENCES engine_runs(id,user_id),
  FOREIGN KEY (run_id,package_id,package_version) REFERENCES engine_runs(id,package_id,package_version),
  FOREIGN KEY (package_id,package_version,set_id) REFERENCES learning_sets(package_id,package_version,id),
  CHECK (jsonb_typeof(questionnaire)='object'),
  CHECK ((result IS NULL AND completed_at IS NULL) OR (result IS NOT NULL AND completed_at IS NOT NULL AND jsonb_typeof(result)='object'))
);
CREATE INDEX diagnostic_sessions_user ON diagnostic_sessions(user_id,created_at DESC,id DESC);
CREATE TABLE diagnostic_skill_results (
  diagnostic_id uuid NOT NULL REFERENCES diagnostic_sessions(id),
  package_id text NOT NULL,
  package_version integer NOT NULL,
  skill_id text NOT NULL,
  questions integer NOT NULL CHECK (questions>0),
  correct integer NOT NULL CHECK (correct>=0 AND correct<=questions),
  independent_correct integer NOT NULL CHECK (independent_correct>=0 AND independent_correct<=correct),
  assisted_correct integer NOT NULL CHECK (assisted_correct>=0 AND assisted_correct<=correct),
  score integer NOT NULL CHECK (score>=0),
  max_score integer NOT NULL CHECK (max_score>0 AND score<=max_score),
  percent integer NOT NULL CHECK (percent BETWEEN 0 AND 100),
  status text NOT NULL CHECK (status IN ('strength','difficulty','mixed')),
  PRIMARY KEY (diagnostic_id,skill_id),
  FOREIGN KEY (package_id,package_version,skill_id) REFERENCES learning_skills(package_id,package_version,id),
  CHECK (independent_correct+assisted_correct=correct)
);
