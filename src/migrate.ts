import { createPool, migrate } from "./db.ts";
import { seed } from "./seed.ts";

const db = createPool(process.env.DATABASE_URL ?? "postgresql://localhost/storefront");
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied ${applied.join(", ")}` : "Database is up to date");
  if (process.argv.includes("--seed")) {
    await seed(db);
    console.log("Added the demo products");
  }
} finally {
  await db.end();
}
