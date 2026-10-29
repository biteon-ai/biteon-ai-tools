import { migrate } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const applied = await migrate(databaseUrl);
console.log(applied.length ? `applied ${applied.join(", ")}` : "database is up to date");
