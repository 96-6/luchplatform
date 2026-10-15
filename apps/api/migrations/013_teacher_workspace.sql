ALTER TABLE engine_attempts ADD CONSTRAINT attempt_review_owner UNIQUE (id,user_id);
ALTER TABLE plan_assignments ADD CONSTRAINT assignment_review_owner UNIQUE (id,user_id);
ALTER TABLE learning_plans ADD CONSTRAINT plan_review_owner UNIQUE (id,user_id);
CREATE TABLE teacher_actions (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id),
  student_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('review','assignment_added','assignment_rescheduled','assignment_cancelled')),
  request jsonb NOT NULL,
  before_state jsonb,
  attempt_id uuid,
  plan_id uuid,
  assignment_id uuid,
  comment text NOT NULL CHECK (length(comment) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL,
  UNIQUE (actor_id,operation_id),
  FOREIGN KEY (attempt_id,student_id) REFERENCES engine_attempts(id,user_id),
  FOREIGN KEY (plan_id,student_id) REFERENCES learning_plans(id,user_id),
  FOREIGN KEY (assignment_id,student_id) REFERENCES plan_assignments(id,user_id),
  CHECK ((kind='review' AND attempt_id IS NOT NULL) OR (kind<>'review' AND plan_id IS NOT NULL AND assignment_id IS NOT NULL))
);
CREATE INDEX teacher_actions_student_page ON teacher_actions(student_id,created_at DESC,id DESC);
CREATE TABLE teacher_reviews (
  id uuid PRIMARY KEY REFERENCES teacher_actions(id),
  attempt_id uuid NOT NULL,
  student_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  revision integer NOT NULL CHECK (revision>0),
  decision text NOT NULL CHECK (decision IN ('comment','confirm','correct')),
  correct boolean,
  comment text NOT NULL CHECK (length(comment) BETWEEN 1 AND 3000),
  created_at timestamptz NOT NULL,
  UNIQUE (attempt_id,revision),
  UNIQUE (id,attempt_id),
  FOREIGN KEY (attempt_id,student_id) REFERENCES engine_attempts(id,user_id),
  CHECK ((decision='comment' AND correct IS NULL) OR (decision<>'comment' AND correct IS NOT NULL))
);
ALTER TABLE engine_attempts ADD COLUMN teacher_correct boolean;
ALTER TABLE engine_attempts ADD COLUMN teacher_review_id uuid;
ALTER TABLE engine_attempts ADD COLUMN review_revision integer NOT NULL DEFAULT 0 CHECK (review_revision>=0);
ALTER TABLE engine_attempts ADD CONSTRAINT current_teacher_review FOREIGN KEY (teacher_review_id,id) REFERENCES teacher_reviews(id,attempt_id);
ALTER TABLE engine_attempts ADD CONSTRAINT teacher_grade_presence CHECK ((teacher_correct IS NULL)=(teacher_review_id IS NULL));
ALTER TABLE skill_observations ADD COLUMN automatic_outcome text;
UPDATE skill_observations SET automatic_outcome=outcome;
ALTER TABLE skill_observations ADD COLUMN teacher_review_id uuid REFERENCES teacher_reviews(id);
ALTER TABLE plan_assignments DROP CONSTRAINT plan_assignments_kind_check;
ALTER TABLE plan_assignments ADD CONSTRAINT plan_assignment_kind CHECK (kind IN ('initial','correction','supported_practice','review','teacher'));
DROP INDEX plan_pending_skill;
CREATE UNIQUE INDEX plan_pending_skill ON plan_assignments(plan_id,skill_id,kind) WHERE kind IN ('correction','supported_practice','review') AND closed_at IS NULL;
ALTER TABLE plan_assignments ADD COLUMN teacher_revision integer NOT NULL DEFAULT 0 CHECK (teacher_revision>=0);
ALTER TABLE plan_assignments ADD COLUMN teacher_note text;
ALTER TABLE plan_assignments ADD COLUMN cancelled_at timestamptz;
ALTER TABLE plan_assignments ADD CONSTRAINT cancelled_assignment_pending CHECK (cancelled_at IS NULL OR (run_id IS NULL AND closed_at IS NOT NULL));
ALTER TABLE learning_plan_changes ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE learning_plan_changes ADD COLUMN teacher_action_id uuid REFERENCES teacher_actions(id);
ALTER TABLE learning_plan_changes ALTER COLUMN outcome DROP NOT NULL;
ALTER TABLE learning_plan_changes ADD CONSTRAINT plan_change_evidence CHECK (event_id IS NOT NULL OR teacher_action_id IS NOT NULL);
ALTER TABLE learning_plan_changes DROP CONSTRAINT learning_plan_changes_action_check;
ALTER TABLE learning_plan_changes ADD CONSTRAINT supported_plan_change CHECK (action IN ('correction_added','correction_reused','supported_practice_added','supported_practice_reused','review_scheduled','review_reused','next_step_ready','review_confirmed','bank_unavailable','teacher_assignment_added','teacher_assignment_rescheduled','teacher_assignment_cancelled','assessment_reviewed'));
CREATE UNIQUE INDEX teacher_plan_change_once ON learning_plan_changes(plan_id,teacher_action_id,action) WHERE teacher_action_id IS NOT NULL;
