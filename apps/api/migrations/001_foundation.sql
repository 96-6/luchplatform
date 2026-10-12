CREATE TABLE system_probes (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE,
  label varchar(120) NOT NULL CHECK (length(btrim(label)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX system_probes_created_idx ON system_probes (created_at DESC, id DESC);
