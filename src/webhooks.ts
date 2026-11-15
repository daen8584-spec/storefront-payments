import type Stripe from "stripe";
import { z } from "zod";
import { type Client, type Db, transaction } from "./db.ts";
import { HttpError, releaseStock, transition } from "./orders.ts";

/**
 * Stripe webhook handling.
 *
 * Stripe delivers every event at least once, may deliver it again, and does not guarantee
 * order. So:
 * - the signature is checked over the raw request body before anything else;
 * - each event id is recorded in the same transaction that applies it, so a repeated
 *   delivery is acknowledged without doing anything twice;
 * - status changes go through a table of allowed transitions, so a late event cannot undo
 *   a newer state;
 * - refunds are applied as Stripe's running total, not by adding amounts, so duplicates
 *   and reordering cannot double count;
 * - an event that cannot be applied yet (a refund for a payment not recorded yet) fails
 *   with 500 and nothing is stored, and Stripe retries it later.
 */

// Only the fields used here are read, and they are validated, so a change in Stripe's
// payloads fails loudly instead of corrupting orders.
const sessionSchema = z.object({
  id: z.string(),
  client_reference_id: z.string().uuid().nullable(),
  payment_status: z.enum(["paid", "unpaid", "no_payment_required"]),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullable(),
  amount_total: z.number().int().nullable(),
  currency: z.string().nullable(),
});

const chargeSchema = z.object({
  id: z.string(),
  payment_intent: z.union([z.string(), z.object({ id: z.string() })]).nullable(),
  amount_refunded: z.number().int(),
});

export class WebhookSignatureError extends Error {}

export function verifyEvent(stripe: Stripe, rawBody: Buffer, signature: string | undefined, secret: string): Stripe.Event {
  if (!signature) throw new WebhookSignatureError("Missing Stripe-Signature header");
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (error) {
    throw new WebhookSignatureError(error instanceof Error ? error.message : "Invalid signature");
  }
}

export type HandleResult = { duplicate: true } | { duplicate: false; orderId: string | null; applied: boolean };

const idOf = (value: string | { id: string } | null) => (value === null ? null : typeof value === "string" ? value : value.id);

async function markPaid(client: Client, orderId: string, session: z.infer<typeof sessionSchema>, reason: string): Promise<boolean> {
  const { rows } = await client.query<{ status: string; total_cents: number; currency: string }>(
    "select status, total_cents, currency from orders where id = $1 for update",
    [orderId],
  );
  const order = rows[0];
  if (!order) return false;
  if (session.amount_total !== order.total_cents || session.currency !== order.currency) {
    // The amount comes from our own session, so this means something is badly wrong.
    throw new Error(`Paid amount ${session.amount_total} ${session.currency} does not match order total ${order.total_cents} ${order.currency}`);
  }
  const wasCancelled = order.status === "cancelled";
  if (!(await transition(client, orderId, "paid", reason))) return false;
  await client.query("update orders set payment_intent_id = $2 where id = $1", [orderId, idOf(session.payment_intent)]);
  if (wasCancelled) {
    // The customer paid after the order was cancelled and its stock released. The money
    // is real, so the order is paid; take the stock again where it is still available
    // and record what could not be covered.
    const { rows: short } = await client.query<{ product_id: string }>(
      `with wanted as (select product_id, quantity from order_items where order_id = $1),
            taken as (
              update products p set stock = p.stock - w.quantity from wanted w
              where p.id = w.product_id and p.stock >= w.quantity returning p.id)
       select product_id from wanted where product_id not in (select id from taken)`,
      [orderId],
    );
    if (short.length > 0) {
      await client.query("insert into order_events (order_id, from_status, to_status, reason) values ($1, 'paid', 'paid', $2)", [
        orderId,
        `needs attention: paid after cancellation and out of stock for ${short.map((s) => s.product_id).join(", ")}`,
      ]);
    }
  }
  return true;
}

async function apply(client: Client, event: Stripe.Event): Promise<{ orderId: string | null; applied: boolean }> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired": {
      const session = sessionSchema.parse(event.data.object);
      const orderId = session.client_reference_id;
      if (!orderId) return { orderId: null, applied: false };
      if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
        const reason = event.type === "checkout.session.expired" ? "checkout expired" : "delayed payment failed";
        const cancelled = await transition(client, orderId, "cancelled", reason);
        if (cancelled) await releaseStock(client, orderId);
        return { orderId, applied: cancelled };
      }
      // Some payment methods (bank debits) complete the checkout before the money arrives;
      // those orders become paid on async_payment_succeeded instead.
      if (session.payment_status !== "paid") return { orderId, applied: false };
      return { orderId, applied: await markPaid(client, orderId, session, `payment received (${event.type})`) };
    }
    case "charge.refunded": {
      const charge = chargeSchema.parse(event.data.object);
      const paymentIntent = idOf(charge.payment_intent);
      const { rows } = await client.query<{ id: string; total_cents: number; refunded_cents: number }>(
        "select id, total_cents, refunded_cents from orders where payment_intent_id = $1 for update",
        [paymentIntent],
      );
      const order = rows[0];
      if (!order) throw new HttpError(500, `No order for payment ${paymentIntent} yet; Stripe will retry`);
      // amount_refunded is Stripe's running total for the charge.
      if (charge.amount_refunded <= order.refunded_cents) return { orderId: order.id, applied: false };
      await client.query("update orders set refunded_cents = $2, updated_at = now() where id = $1", [order.id, charge.amount_refunded]);
      const to = charge.amount_refunded >= order.total_cents ? "refunded" : "partially_refunded";
      await transition(client, order.id, to, `refunded ${charge.amount_refunded} of ${order.total_cents} cents`);
      return { orderId: order.id, applied: true };
    }
    default:
      return { orderId: null, applied: false };
  }
}

export async function handleEvent(db: Db, event: Stripe.Event): Promise<HandleResult> {
  return transaction(db, async (client) => {
    const inserted = await client.query("insert into stripe_events (id, type) values ($1, $2) on conflict (id) do nothing", [
      event.id,
      event.type,
    ]);
    if (inserted.rowCount === 0) return { duplicate: true };
    const result = await apply(client, event);
    if (result.orderId) await client.query("update stripe_events set order_id = $2 where id = $1", [event.id, result.orderId]);
    return { duplicate: false, ...result };
  });
}
