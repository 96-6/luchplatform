ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT user_supported_role CHECK (role IN ('student','teacher','admin','superadmin'));
CREATE TABLE ai_configuration (
  id smallint PRIMARY KEY CHECK (id=1),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  ceilings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ceilings)='object'),
  controls jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(controls)='object'),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_configuration (id) VALUES (1);
CREATE TABLE external_providers (
  id text PRIMARY KEY CHECK (id IN ('openai','neuroapi','elevenlabs')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  enabled boolean NOT NULL DEFAULT false,
  credential_ciphertext text,
  key_disabled boolean NOT NULL DEFAULT false,
  model text NOT NULL,
  voice_ru text NOT NULL DEFAULT '',
  voice_en text NOT NULL DEFAULT '',
  input_rate bigint CHECK (input_rate>0),
  output_rate bigint CHECK (output_rate>0),
  character_rate bigint CHECK (character_rate>0),
  pricing_confirmed_at timestamptz,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO external_providers (id,model) VALUES ('openai','gpt-4.1-mini'),('neuroapi','gpt-4.1-mini'),('elevenlabs','eleven_multilingual_v2');
CREATE TABLE provider_requests (
  id uuid PRIMARY KEY,
  resource_key text NOT NULL UNIQUE,
  cache_key text,
  kind text NOT NULL CHECK (kind IN ('adaptive_exercise','listening')),
  user_id uuid NOT NULL REFERENCES users(id),
  requested_by uuid NOT NULL REFERENCES users(id),
  assignment_id uuid REFERENCES plan_assignments(id),
  provider text NOT NULL REFERENCES external_providers(id),
  model text NOT NULL,
  rates jsonb NOT NULL CHECK (jsonb_typeof(rates)='object'),
  reserved_micros bigint NOT NULL CHECK (reserved_micros>0),
  charged_micros bigint NOT NULL CHECK (charged_micros>=0),
  input_units integer NOT NULL CHECK (input_units>=0),
  output_units integer NOT NULL CHECK (output_units>=0),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','success','failed','unknown','overrun')),
  result_id uuid,
  error_code text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);
CREATE UNIQUE INDEX provider_active_audio ON provider_requests(cache_key) WHERE status='reserved' AND kind='listening';
CREATE INDEX provider_requests_spend ON provider_requests(created_at,user_id);
CREATE TABLE listening_audio_cache (
  cache_key char(64) PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES provider_requests(id),
  audio bytea NOT NULL CHECK (octet_length(audio) BETWEEN 1 AND 2097152),
  created_at timestamptz NOT NULL
);
CREATE TABLE run_listening_assets (
  run_id uuid NOT NULL,
  step_id uuid NOT NULL,
  cache_key char(64) NOT NULL REFERENCES listening_audio_cache(cache_key),
  PRIMARY KEY (run_id,step_id,cache_key),
  FOREIGN KEY (run_id,step_id) REFERENCES engine_steps(run_id,id)
);
