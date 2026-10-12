CREATE TABLE content_packages (
  id text PRIMARY KEY,
  current_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (current_version IS NULL OR current_version > 0)
);

CREATE TABLE content_revisions (
  package_id text NOT NULL REFERENCES content_packages(id),
  version integer NOT NULL CHECK (version > 0),
  manifest jsonb NOT NULL,
  checksum char(64) NOT NULL,
  imported_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (package_id, version)
);
ALTER TABLE content_packages ADD CONSTRAINT content_current_revision
  FOREIGN KEY (id, current_version) REFERENCES content_revisions(package_id, version);

CREATE TABLE learning_routes (
  package_id text NOT NULL,
  package_version integer NOT NULL,
  id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  definition jsonb NOT NULL,
  PRIMARY KEY (package_id, package_version, id),
  UNIQUE (package_id, package_version, position),
  FOREIGN KEY (package_id, package_version) REFERENCES content_revisions(package_id, version)
);
CREATE TABLE learning_skills (
  package_id text NOT NULL,
  package_version integer NOT NULL,
  id text NOT NULL,
  definition jsonb NOT NULL,
  PRIMARY KEY (package_id, package_version, id),
  FOREIGN KEY (package_id, package_version) REFERENCES content_revisions(package_id, version)
);
CREATE TABLE learning_lessons (
  package_id text NOT NULL,
  package_version integer NOT NULL,
  id text NOT NULL,
  route_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  definition jsonb NOT NULL,
  PRIMARY KEY (package_id, package_version, id),
  UNIQUE (package_id, package_version, route_id, position),
  FOREIGN KEY (package_id, package_version, route_id) REFERENCES learning_routes(package_id, package_version, id)
);
CREATE TABLE learning_exercises (
  package_id text NOT NULL,
  package_version integer NOT NULL,
  id text NOT NULL,
  exercise_version integer NOT NULL CHECK (exercise_version > 0),
  lesson_id text NOT NULL,
  skill_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('diagnostic','practice','control')),
  position integer NOT NULL CHECK (position >= 0),
  definition jsonb NOT NULL,
  PRIMARY KEY (package_id, package_version, id),
  UNIQUE (package_id, package_version, id, purpose),
  FOREIGN KEY (package_id, package_version, lesson_id) REFERENCES learning_lessons(package_id, package_version, id),
  FOREIGN KEY (package_id, package_version, skill_id) REFERENCES learning_skills(package_id, package_version, id)
);
CREATE INDEX learning_exercises_lesson ON learning_exercises(package_id, package_version, lesson_id, purpose, position);

CREATE TABLE learning_sets (
  package_id text NOT NULL,
  package_version integer NOT NULL,
  id text NOT NULL,
  route_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('diagnostic','practice','control')),
  definition jsonb NOT NULL,
  PRIMARY KEY (package_id, package_version, id),
  UNIQUE (package_id, package_version, id, purpose),
  FOREIGN KEY (package_id, package_version, route_id) REFERENCES learning_routes(package_id, package_version, id)
);
CREATE TABLE learning_set_exercises (
  package_id text NOT NULL,
  package_version integer NOT NULL,
  set_id text NOT NULL,
  exercise_id text NOT NULL,
  purpose text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (package_id, package_version, set_id, exercise_id),
  UNIQUE (package_id, package_version, set_id, position),
  FOREIGN KEY (package_id, package_version, set_id, purpose) REFERENCES learning_sets(package_id, package_version, id, purpose),
  FOREIGN KEY (package_id, package_version, exercise_id, purpose) REFERENCES learning_exercises(package_id, package_version, id, purpose)
);
CREATE TABLE learning_assets (
  package_id text NOT NULL,
  package_version integer NOT NULL,
  id text NOT NULL,
  definition jsonb NOT NULL,
  PRIMARY KEY (package_id, package_version, id),
  FOREIGN KEY (package_id, package_version) REFERENCES content_revisions(package_id, version)
);
