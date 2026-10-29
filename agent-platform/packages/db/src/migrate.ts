import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

export async function migrate(databaseUrl: string, dir = migrationsDir): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1 });
  const applied: string[] = [];
  try {
    await sql`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
    const files = (await readdir(dir)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await sql`SELECT id FROM schema_migrations WHERE id = ${file}`;
      if (existing.length > 0) continue;
      const body = await readFile(path.join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`INSERT INTO schema_migrations (id) VALUES (${file})`;
      });
      applied.push(file);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  return applied;
}
