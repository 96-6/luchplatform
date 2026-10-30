CREATE TABLE meeting_recording_policy (
 id smallint PRIMARY KEY CHECK (id=1),
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by uuid REFERENCES users(id)
);
INSERT INTO meeting_recording_policy(id) VALUES(1);
