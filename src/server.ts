import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { releaseAbandoned } from "./orders.ts";
import { createStripe } from "./stripe.ts";

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
const app = buildApp({ db, stripe: createStripe(config.STRIPE_SECRET_KEY), config, logger: true });

// Releases stock held by checkouts that never reached Stripe (see releaseAbandoned).
const sweeper = setInterval(() => {
  releaseAbandoned(db).catch((error: unknown) => app.log.error(error, "releasing abandoned orders failed"));
}, 60_000);

const shutdown = async () => {
  clearInterval(sweeper);
  await app.close();
  await db.end();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

await app.listen({ port: config.PORT, host: "0.0.0.0" });
