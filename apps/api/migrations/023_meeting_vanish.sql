ALTER TABLE meeting_sessions ADD COLUMN vanish boolean NOT NULL DEFAULT false;
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_vanish_account CHECK (NOT vanish OR (user_id IS NOT NULL AND guest_id IS NULL));
ALTER TABLE meeting_sessions ADD CONSTRAINT meeting_vanish_hand CHECK (NOT vanish OR hand_raised_at IS NULL);
