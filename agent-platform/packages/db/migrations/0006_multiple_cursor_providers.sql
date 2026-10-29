DROP INDEX IF EXISTS providers_builtin_type_unique;
CREATE UNIQUE INDEX providers_ollama_type_unique ON providers (type) WHERE type = 'ollama';
