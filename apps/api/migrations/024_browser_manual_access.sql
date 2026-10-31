CREATE TABLE browser_access_links (
 id uuid PRIMARY KEY,
 created_by uuid NOT NULL REFERENCES users(id),
 operation_id uuid NOT NULL,
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
 single_use boolean NOT NULL,
 token_hash char(64) NOT NULL UNIQUE,
 token_ciphertext text NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz,
 revoked_at timestamptz,
 revoked_by uuid REFERENCES users(id),
 UNIQUE(created_by,operation_id)
);
CREATE INDEX browser_access_link_page ON browser_access_links(created_at,id);
CREATE TABLE browser_access_devices (
 id uuid PRIMARY KEY,
 link_id uuid NOT NULL REFERENCES browser_access_links(id) ON DELETE CASCADE,
 token_hash char(64) NOT NULL UNIQUE,
 label text NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
 browser text NOT NULL,
 platform text NOT NULL,
 user_agent text NOT NULL,
 first_ip text NOT NULL,
 last_ip text NOT NULL,
 created_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 last_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
 revoked_at timestamptz,
 revoked_by uuid REFERENCES users(id)
);
CREATE INDEX browser_access_device_page ON browser_access_devices(link_id,created_at,id);
