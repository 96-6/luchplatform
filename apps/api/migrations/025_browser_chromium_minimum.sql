ALTER TABLE browser_policy ALTER COLUMN minimum_versions SET DEFAULT
 '{"chromium":134,"firefox":153,"webkit":26,"yandex":152}'::jsonb;

UPDATE browser_policy SET
 minimum_versions=jsonb_set(minimum_versions,'{chromium}','134'::jsonb),
 revision=revision+1,
 updated_at=now(),
 updated_by=NULL
WHERE minimum_versions->>'chromium'='154';
