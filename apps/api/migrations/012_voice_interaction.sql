ALTER TABLE external_providers DROP CONSTRAINT supported_external_provider;
ALTER TABLE external_providers ADD CONSTRAINT supported_external_provider CHECK (id IN ('openai','neuroapi','elevenlabs','elevenlabs_stt','heygen'));
INSERT INTO external_providers (id,model) VALUES ('elevenlabs_stt','scribe_v2');
ALTER TABLE provider_requests DROP CONSTRAINT supported_provider_request_kind;
ALTER TABLE provider_requests ADD CONSTRAINT supported_provider_request_kind CHECK (kind IN ('adaptive_exercise','listening','avatar_video','transcription','assistant_speech'));
ALTER TABLE assistant_exchanges DROP CONSTRAINT assistant_exchanges_action_check;
ALTER TABLE assistant_exchanges ADD CONSTRAINT supported_assistant_action CHECK (action IN ('explain','hint','dialogue','answer'));
CREATE TABLE speech_inputs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  run_id uuid NOT NULL,
  step_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('voice','text')),
  origin_id uuid REFERENCES speech_inputs(id),
  audio_hash char(64),
  audio bytea CHECK (audio IS NULL OR octet_length(audio) BETWEEN 3244 AND 960044),
  duration_ms integer NOT NULL CHECK (duration_ms BETWEEN 0 AND 30000),
  language text NOT NULL CHECK (language IN ('ru','en')),
  status text NOT NULL CHECK (status IN ('processing','ready','error','discarded','confirmed')),
  transcript text CHECK (transcript IS NULL OR length(transcript)<=1000),
  confirmed_text text CHECK (confirmed_text IS NULL OR length(confirmed_text) BETWEEN 1 AND 1000),
  confirmed_option_id text,
  confirm_operation_id uuid,
  confirmed_by uuid REFERENCES users(id),
  attempt_id uuid UNIQUE REFERENCES engine_attempts(id),
  exchange_id uuid UNIQUE REFERENCES assistant_exchanges(id),
  provider_request_id uuid UNIQUE REFERENCES provider_requests(id),
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  audio_expires_at timestamptz NOT NULL,
  UNIQUE (user_id,operation_id),
  UNIQUE (id,user_id,run_id,turn_id),
  FOREIGN KEY (run_id,user_id) REFERENCES engine_runs(id,user_id),
  FOREIGN KEY (run_id,step_id) REFERENCES engine_steps(run_id,id),
  FOREIGN KEY (step_id,turn_id) REFERENCES engine_turns(step_id,id),
  CHECK ((status='confirmed' AND attempt_id IS NOT NULL AND exchange_id IS NOT NULL AND confirmed_text IS NOT NULL AND confirm_operation_id IS NOT NULL AND confirmed_by IS NOT NULL) OR (status<>'confirmed' AND attempt_id IS NULL AND exchange_id IS NULL AND confirmed_text IS NULL AND confirm_operation_id IS NULL AND confirmed_by IS NULL))
);
CREATE INDEX speech_run_turn ON speech_inputs(run_id,turn_id,created_at DESC,id DESC);
ALTER TABLE engine_attempts ADD COLUMN speech_input_id uuid;
ALTER TABLE engine_attempts ADD CONSTRAINT attempt_speech_owner FOREIGN KEY (speech_input_id,user_id,run_id,turn_id) REFERENCES speech_inputs(id,user_id,run_id,turn_id);
CREATE TABLE assistant_audio_cache (
  cache_key char(64) PRIMARY KEY,
  request_id uuid NOT NULL UNIQUE REFERENCES provider_requests(id),
  audio bytea NOT NULL CHECK (octet_length(audio) BETWEEN 1 AND 2097152),
  created_at timestamptz NOT NULL
);
CREATE TABLE assistant_message_audio (
  exchange_id uuid PRIMARY KEY REFERENCES assistant_exchanges(id),
  cache_key char(64) NOT NULL REFERENCES assistant_audio_cache(cache_key)
);
