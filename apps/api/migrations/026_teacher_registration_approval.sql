ALTER TABLE users ADD COLUMN teacher_approval_required boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN teacher_approved_at timestamptz;
ALTER TABLE users ADD COLUMN teacher_approved_by uuid REFERENCES users(id);
ALTER TABLE users ADD CONSTRAINT teacher_approval_actor CHECK
 ((teacher_approved_at IS NULL)=(teacher_approved_by IS NULL));
ALTER TABLE users ADD CONSTRAINT teacher_approval_pending CHECK
 (NOT teacher_approval_required OR (role='teacher' AND teacher_approved_at IS NULL));
CREATE INDEX users_pending_teacher_approval ON users(created_at DESC,id)
 WHERE teacher_approval_required;
