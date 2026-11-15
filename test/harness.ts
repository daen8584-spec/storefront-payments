import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { buildApp } from "../src/app.ts";
import { createPool, type Db, migrate } from "../src/db.ts";
import { seed } from "../src/seed.ts";
import { createStripe } from "../src/stripe.ts";
import { type FakeStripe, startFakeStripe } from "./fakeStripe.ts";

export const WEBHOOK_SECRET = "whsec_test_secret_for_tests";
export const ADMIN_TOKEN = "admin-token-for-tests-0123456789";

export interface Harness {
  db: Db;
  app: FastifyInstance;
  stripe: Stripe;
  fake: FakeStripe;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const db = createPool(process.env.TEST_DATABASE_URL ?? "postgresql://localhost/storefront_test");
  await migrate(db);
  const fake = await startFakeStripe();
  const stripe = createStripe("sk_test_fake", { host: "127.0.0.1", port: fake.port, protocol: "http" });
  const app = buildApp({
    db,
    stripe,
    config: { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, ADMIN_TOKEN, PUBLIC_URL: "http://shop.test", CHECKOUT_EXPIRES_MINUTES: 30 },
  });
  return {
    db,
    app,
    stripe,
    fake,
    async reset() {
      await db.query("truncate stripe_events, order_events, order_items, orders, products cascade");
      await seed(db);
      fake.requests.length = 0;
      fake.failNext(0);
    },
    async close() {
      await app.close();
      await fake.close();
      await db.end();
    },
  };
}

/** A Stripe event signed the way Stripe signs it, ready to POST to the webhook. */
export function signedEvent(stripe: Stripe, type: string, object: Record<string, unknown>, eventId = `evt_${randomBytes(8).toString("hex")}`) {
  const payload = JSON.stringify({ id: eventId, object: "event", type, created: Math.floor(Date.now() / 1000), data: { object } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  return { payload, signature, eventId };
}

export async function deliver(h: Harness, type: string, object: Record<string, unknown>, eventId?: string) {
  const { payload, signature } = signedEvent(h.stripe, type, object, eventId);
  return h.app.inject({
    method: "POST",
    url: "/webhooks/stripe",
    headers: { "content-type": "application/json", "stripe-signature": signature },
    payload,
  });
}

export function session(orderId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `cs_test_${orderId.slice(0, 8)}`,
    object: "checkout.session",
    client_reference_id: orderId,
    payment_status: "paid",
    payment_intent: `pi_${orderId.replace(/-/g, "").slice(0, 16)}`,
    amount_total: 0,
    currency: "usd",
    ...overrides,
  };
}

export function charge(paymentIntent: string, amountRefunded: number) {
  return { id: `ch_${paymentIntent.slice(3)}`, object: "charge", payment_intent: paymentIntent, amount_refunded: amountRefunded };
}

export async function checkout(h: Harness, items: { productId: string; quantity: number }[]) {
  const response = await h.app.inject({ method: "POST", url: "/api/checkout", payload: { items } });
  return { response, body: response.json() as { orderId: string; checkoutUrl: string; error?: string } };
}

export async function stock(h: Harness, productId: string): Promise<number> {
  const { rows } = await h.db.query<{ stock: number }>("select stock from products where id = $1", [productId]);
  return rows[0]!.stock;
}

export async function orderRow(h: Harness, orderId: string) {
  const { rows } = await h.db.query("select * from orders where id = $1", [orderId]);
  return rows[0] as { status: string; total_cents: number; refunded_cents: number; payment_intent_id: string | null; checkout_session_id: string | null };
}

/** Starts a checkout and confirms its payment through a webhook, like a completed purchase. */
export async function paidOrder(h: Harness, items = [{ productId: "mug", quantity: 2 }]) {
  const { body } = await checkout(h, items);
  const total = (await orderRow(h, body.orderId)).total_cents;
  const paid = session(body.orderId, { amount_total: total });
  await deliver(h, "checkout.session.completed", paid);
  return { orderId: body.orderId, total, paymentIntent: paid.payment_intent as string };
}
