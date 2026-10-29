ALTER TABLE agents ADD COLUMN linked_repositories jsonb NOT NULL DEFAULT '[]';
