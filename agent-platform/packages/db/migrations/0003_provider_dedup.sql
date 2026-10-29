CREATE TEMP TABLE provider_drop (
  drop_id uuid PRIMARY KEY,
  keep_id uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO provider_drop (drop_id, keep_id)
SELECT id, keep_id
FROM (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY type ORDER BY created_at, id) AS keep_id,
    row_number() OVER (PARTITION BY type ORDER BY created_at, id) AS rn
  FROM providers
  WHERE type <> 'custom'
) ranked
WHERE rn > 1;

UPDATE models AS model
SET provider_id = provider_drop.keep_id
FROM provider_drop
WHERE model.provider_id = provider_drop.drop_id;

DELETE FROM providers AS provider
USING provider_drop
WHERE provider.id = provider_drop.drop_id;

DELETE FROM provider_drop;

INSERT INTO provider_drop (drop_id, keep_id)
SELECT id, keep_id
FROM (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY lower(btrim(name)) ORDER BY created_at, id) AS keep_id,
    row_number() OVER (PARTITION BY lower(btrim(name)) ORDER BY created_at, id) AS rn
  FROM providers
) ranked
WHERE rn > 1;

UPDATE models AS model
SET provider_id = provider_drop.keep_id
FROM provider_drop
WHERE model.provider_id = provider_drop.drop_id;

DELETE FROM providers AS provider
USING provider_drop
WHERE provider.id = provider_drop.drop_id;

CREATE TEMP TABLE model_drop (
  drop_id uuid PRIMARY KEY,
  keep_id uuid NOT NULL
) ON COMMIT DROP;

INSERT INTO model_drop (drop_id, keep_id)
SELECT id, keep_id
FROM (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY provider_id, lower(btrim(model_id)) ORDER BY created_at, id) AS keep_id,
    row_number() OVER (PARTITION BY provider_id, lower(btrim(model_id)) ORDER BY created_at, id) AS rn
  FROM models
) ranked
WHERE rn > 1;

UPDATE model_assignments AS assignment
SET model_id = model_drop.keep_id
FROM model_drop
WHERE assignment.model_id = model_drop.drop_id;

UPDATE model_assignments AS assignment
SET fallback_model_id = model_drop.keep_id
FROM model_drop
WHERE assignment.fallback_model_id = model_drop.drop_id;

DELETE FROM models AS model
USING model_drop
WHERE model.id = model_drop.drop_id;

DELETE FROM model_drop;

INSERT INTO model_drop (drop_id, keep_id)
SELECT id, keep_id
FROM (
  SELECT
    id,
    first_value(id) OVER (PARTITION BY provider_id, lower(btrim(display_name)) ORDER BY created_at, id) AS keep_id,
    row_number() OVER (PARTITION BY provider_id, lower(btrim(display_name)) ORDER BY created_at, id) AS rn
  FROM models
) ranked
WHERE rn > 1;

UPDATE model_assignments AS assignment
SET model_id = model_drop.keep_id
FROM model_drop
WHERE assignment.model_id = model_drop.drop_id;

UPDATE model_assignments AS assignment
SET fallback_model_id = model_drop.keep_id
FROM model_drop
WHERE assignment.fallback_model_id = model_drop.drop_id;

DELETE FROM models AS model
USING model_drop
WHERE model.id = model_drop.drop_id;

CREATE UNIQUE INDEX providers_name_lower_unique ON providers (lower(btrim(name)));
CREATE UNIQUE INDEX providers_builtin_type_unique ON providers (type) WHERE type <> 'custom';
