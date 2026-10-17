ALTER TABLE users ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN block_reason text NOT NULL DEFAULT '';
ALTER TABLE users ADD CONSTRAINT users_block_reason_length CHECK (length(block_reason) <= 1000);
