ALTER TABLE browser_policy ALTER COLUMN minimum_versions SET DEFAULT
 '{"chromium":154,"firefox":153,"webkit":26,"yandex":152}'::jsonb;

UPDATE browser_policy SET
 minimum_versions=minimum_versions || '{"yandex":152}'::jsonb,
 revision=revision+1,
 updated_at=now(),
 updated_by=NULL
WHERE NOT (minimum_versions ? 'yandex');
