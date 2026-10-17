-- Stable keyset pagination and per-learner report reads over existing immutable evidence.
-- Reports are derived; no answer, grade or integrity assessment is rewritten.
CREATE INDEX engine_attempts_report_page ON engine_attempts(user_id,evaluated_at DESC,id DESC);
CREATE INDEX plan_assignments_report_user ON plan_assignments(user_id,plan_id);
