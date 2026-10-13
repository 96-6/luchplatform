CREATE TABLE assistant_profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  revision integer NOT NULL CHECK (revision>0),
  preferences jsonb NOT NULL CHECK (jsonb_typeof(preferences)='object'),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL
);
CREATE TABLE assistant_exchanges (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  run_id uuid NOT NULL REFERENCES engine_runs(id),
  step_id uuid NOT NULL,
  turn_id uuid NOT NULL REFERENCES engine_turns(id),
  operation_id uuid NOT NULL,
  request jsonb NOT NULL,
  context jsonb NOT NULL,
  preferences jsonb NOT NULL,
  action text NOT NULL CHECK (action IN ('explain','hint','dialogue')),
  user_text text NOT NULL CHECK (length(user_text)<=1000),
  assistant_text text NOT NULL CHECK (length(assistant_text) BETWEEN 1 AND 5000),
  actor_id uuid NOT NULL REFERENCES users(id),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  created_at timestamptz NOT NULL,
  UNIQUE (user_id,operation_id),
  FOREIGN KEY (run_id,step_id) REFERENCES engine_steps(run_id,id)
);
CREATE INDEX assistant_run_history ON assistant_exchanges(run_id,sequence);
ALTER TABLE engine_turns ADD COLUMN assistant_help boolean NOT NULL DEFAULT false;
ALTER TABLE engine_attempts ADD COLUMN assistant_help boolean NOT NULL DEFAULT false;
CREATE TABLE learning_content_views (
  user_id uuid NOT NULL REFERENCES users(id),
  content_key text NOT NULL,
  first_viewed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id,content_key)
);
INSERT INTO learning_content_views (user_id,content_key,first_viewed_at) SELECT r.user_id,CASE WHEN s.generated_exercise_id IS NOT NULL THEN 'generated:'||s.generated_exercise_id::text ELSE 'bank:'||s.package_id||':'||s.package_version::text||':'||s.exercise_id||':'||s.exercise_version::text END,min(r.created_at) FROM engine_steps s JOIN engine_runs r ON r.id=s.run_id WHERE s.state<>'pending' GROUP BY r.user_id,s.generated_exercise_id,s.package_id,s.package_version,s.exercise_id,s.exercise_version ON CONFLICT DO NOTHING;
ALTER TABLE plan_assignments ADD COLUMN cache_fallback boolean NOT NULL DEFAULT false;
ALTER TABLE external_providers DROP CONSTRAINT external_providers_id_check;
ALTER TABLE external_providers ADD CONSTRAINT supported_external_provider CHECK (id IN ('openai','neuroapi','elevenlabs','heygen'));
ALTER TABLE external_providers ADD COLUMN minute_rate bigint CHECK (minute_rate>0);
INSERT INTO external_providers (id,model) VALUES ('heygen','avatar_iv');
ALTER TABLE provider_requests DROP CONSTRAINT provider_requests_kind_check;
ALTER TABLE provider_requests ADD CONSTRAINT supported_provider_request_kind CHECK (kind IN ('adaptive_exercise','listening','avatar_video'));
CREATE TABLE avatar_configuration (
  id smallint PRIMARY KEY CHECK (id=1),
  revision integer NOT NULL DEFAULT 1,
  bindings jsonb NOT NULL DEFAULT '[{"id":"mentor","avatarId":"","voiceRu":"","voiceEn":""},{"id":"partner","avatarId":"","voiceRu":"","voiceEn":""},{"id":"guide","avatarId":"","voiceRu":"","voiceEn":""}]',
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO avatar_configuration (id) VALUES (1);
CREATE TABLE avatar_video_jobs (
  cache_key char(64) PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES provider_requests(id),
  content_key char(64) NOT NULL,
  remote_id text,
  credential_ciphertext text,
  reservation jsonb NOT NULL,
  status text NOT NULL DEFAULT 'submitting' CHECK (status IN ('submitting','pending','ready','error')),
  next_poll_at timestamptz NOT NULL DEFAULT now(),
  error_code text,
  created_at timestamptz NOT NULL
);
CREATE TABLE avatar_video_cache (
  cache_key char(64) PRIMARY KEY REFERENCES avatar_video_jobs(cache_key),
  video bytea NOT NULL CHECK (octet_length(video) BETWEEN 1 AND 33554432),
  duration integer NOT NULL CHECK (duration>0),
  created_at timestamptz NOT NULL
);
CREATE TABLE assistant_message_videos (
  exchange_id uuid PRIMARY KEY REFERENCES assistant_exchanges(id),
  cache_key char(64) NOT NULL REFERENCES avatar_video_jobs(cache_key)
);

CREATE INDEX avatar_video_content ON avatar_video_jobs(content_key,status);
CREATE TABLE avatar_video_views (
  user_id uuid NOT NULL REFERENCES users(id),
  cache_key char(64) NOT NULL REFERENCES avatar_video_cache(cache_key),
  first_viewed_at timestamptz NOT NULL,
  PRIMARY KEY (user_id,cache_key)
);
