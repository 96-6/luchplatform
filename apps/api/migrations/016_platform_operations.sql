CREATE TABLE platform_operations (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('recover_learning','retry_video','seed_content','expire_audio')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  result jsonb,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE(actor_id,operation_id),
  CHECK ((status='running' AND completed_at IS NULL AND result IS NULL) OR (status<>'running' AND completed_at IS NOT NULL AND result IS NOT NULL))
);
CREATE INDEX platform_operations_recent ON platform_operations(created_at DESC,id DESC);
