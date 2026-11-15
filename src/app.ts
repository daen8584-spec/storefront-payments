import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type Stripe from "stripe";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Db } from "./db.ts";
import { checkoutSchema, getOrder, HttpError, requestRefund, startCheckout } from "./orders.ts";
import { handleEvent, verifyEvent, WebhookSignatureError } from "./webhooks.ts";

export interface AppDeps {
  db: Db;
  stripe: Stripe;
  config: Pick<Config, "STRIPE_WEBHOOK_SECRET" | "ADMIN_TOKEN" | "PUBLIC_URL" | "CHECKOUT_EXPIRES_MINUTES">;
  logger?: boolean;
}

const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");
const STATIC_FILES: Record<string, string> = {
  "/": "index.html",
  "/order.html": "order.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};
const CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const uuid = z.uuid();

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildApp({ db, stripe, config, logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof HttpError) return reply.status(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: "Invalid request", details: error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
    if (error.statusCode && error.statusCode < 500) return reply.status(error.statusCode).send({ error: error.message });
    request.log.error(error);
    return reply.status(500).send({ error: "Internal server error" });
  });

  const requireAdmin = async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!sameSecret(token, config.ADMIN_TOKEN)) return reply.status(401).send({ error: "Unauthorized" });
  };

  for (const [route, file] of Object.entries(STATIC_FILES)) {
    app.get(route, async (_request, reply) => {
      const body = await readFile(path.join(PUBLIC_DIR, file));
      return reply.type(CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream").send(body);
    });
  }

  app.get("/health", async () => {
    await db.query("select 1");
    return { ok: true };
  });

  app.get("/api/products", async () => {
    const { rows } = await db.query(
      "select id, name, description, price_cents as \"priceCents\", currency, stock from products order by name",
    );
    return rows;
  });

  app.post("/api/checkout", async (request, reply) => {
    const body = checkoutSchema.parse(request.body);
    const result = await startCheckout(db, stripe, { publicUrl: config.PUBLIC_URL, expiresMinutes: config.CHECKOUT_EXPIRES_MINUTES }, body);
    return reply.status(201).send(result);
  });

  // An order id is a random UUID, so knowing it is enough to see that order's status.
  app.get<{ Params: { id: string } }>("/api/orders/:id", async (request, reply) => {
    if (!uuid.safeParse(request.params.id).success) return reply.status(404).send({ error: "Order not found" });
    const order = await getOrder(db, request.params.id);
    if (!order) return reply.status(404).send({ error: "Order not found" });
    return order;
  });

  // Stripe signs the exact bytes it sends, so this route keeps the body unparsed.
  app.register(async (webhooks) => {
    webhooks.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    webhooks.post("/webhooks/stripe", async (request, reply) => {
      let event: Stripe.Event;
      try {
        event = verifyEvent(stripe, request.body as Buffer, request.headers["stripe-signature"] as string | undefined, config.STRIPE_WEBHOOK_SECRET);
      } catch (error) {
        if (error instanceof WebhookSignatureError) return reply.status(400).send({ error: error.message });
        throw error;
      }
      const result = await handleEvent(db, event);
      request.log.info({ event: event.id, type: event.type, ...result }, "stripe event");
      return { received: true, ...result };
    });
  });

  app.register(async (admin) => {
    admin.addHook("onRequest", requireAdmin);

    admin.get("/api/admin/orders", async () => {
      const { rows } = await db.query(
        `select id, status, total_cents as "totalCents", refunded_cents as "refundedCents", currency, email, created_at as "createdAt"
         from orders order by created_at desc limit 100`,
      );
      return rows;
    });

    admin.get<{ Params: { id: string } }>("/api/admin/orders/:id/events", async (request) => {
      const { rows } = await db.query(
        `select from_status as "from", to_status as "to", reason, created_at as "at" from order_events where order_id = $1 order by id`,
        [request.params.id],
      );
      return rows;
    });

    const refundSchema = z.object({ amountCents: z.number().int().positive().optional() });
    admin.post<{ Params: { id: string } }>("/api/admin/orders/:id/refunds", async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || key.length < 8 || key.length > 100) {
        return reply.status(400).send({ error: "An Idempotency-Key header of 8 to 100 characters is required" });
      }
      if (!uuid.safeParse(request.params.id).success) return reply.status(404).send({ error: "Order not found" });
      const { amountCents } = refundSchema.parse(request.body ?? {});
      return reply.status(202).send(await requestRefund(db, stripe, request.params.id, amountCents, key));
    });
  });

  return app;
}
