import { describe, expect, it } from "vitest";
import { migrate } from "./migrate.js";
import { PostgresStore } from "./postgres.js";
import { assertStoreRoundTrip } from "./memory.test.js";

const databaseUrl = process.env.DATABASE_URL;
const local = Boolean(databaseUrl && (databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1") || databaseUrl.includes("@postgres:")));

describe("postgres store", () => {
  it.skipIf(!local)("applies migrations and round-trips a local database", async () => {
    await migrate(databaseUrl!);
    const store = new PostgresStore(databaseUrl!);
    try {
      expect(await store.ping()).toBe(true);
      await assertStoreRoundTrip(store);
    } finally {
      await store.close();
    }
  });
});
