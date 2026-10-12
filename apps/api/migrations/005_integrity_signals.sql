CREATE TABLE engine_integrity_policy (
  id smallint PRIMARY KEY CHECK (id=1),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);
INSERT INTO engine_integrity_policy (id) VALUES (1);

CREATE TABLE engine_integrity_packets (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES engine_turns(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  stats jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (turn_id,actor_id,batch_id)
);
CREATE INDEX engine_integrity_packets_turn ON engine_integrity_packets(turn_id,created_at);

CREATE TABLE engine_integrity_assessments (
  attempt_id uuid PRIMARY KEY REFERENCES engine_attempts(id),
  turn_id uuid NOT NULL UNIQUE REFERENCES engine_turns(id),
  assessment jsonb NOT NULL,
  requires_review boolean NOT NULL,
  created_at timestamptz NOT NULL
);
