import type Stripe from "stripe";
import { z } from "zod";
import { type Client, type Db, transaction } from "./db.ts";

export type OrderStatus = "pending" | "paid" | "cancelled" | "refunded" | "partially_refunded";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const checkoutSchema = z.object({
  items: z
    .array(z.object({ productId: z.string().min(1).max(64), quantity: z.number().int().min(1).max(10) }))
    .min(1)
    .max(20)
    .refine((items) => new Set(items.map((i) => i.productId)).size === items.length, "Each product may appear once"),
  email: z.email().optional(),
});

export type CheckoutRequest = z.infer<typeof checkoutSchema>;

/**
 * Which status changes are allowed. Stripe can deliver events late or out of order, so a
 * change that is not listed here is ignored instead of applied: for example, a late
 * "expired" event must not cancel an order that has already been paid.
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  // A payment can complete after its order was cancelled (see markPaid).
  cancelled: ["paid"],
  paid: ["refunded", "partially_refunded"],
  partially_refunded: ["refunded", "partially_refunded"],
  refunded: [],
};

/** Changes an order's status if the change is allowed. Returns whether it changed. */
export async function transition(client: Client, orderId: string, to: OrderStatus, reason: string): Promise<boolean> {
  const { rows } = await client.query<{ status: OrderStatus }>("select status from orders where id = $1 for update", [orderId]);
  const from = rows[0]?.status;
  if (!from || !TRANSITIONS[from].includes(to)) return false;
  await client.query("update orders set status = $2, updated_at = now() where id = $1", [orderId, to]);
  await client.query("insert into order_events (order_id, from_status, to_status, reason) values ($1, $2, $3, $4)", [
    orderId,
    from,
    to,
    reason,
  ]);
  return true;
}

interface ReservedItem {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  currency: string;
}

/**
 * Reserves stock and records a pending order in one transaction. Prices come from the
 * database, never from the request. Product rows are locked in id order, so concurrent
 * checkouts for the same products queue instead of deadlocking or overselling.
 */
async function reserveOrder(db: Db, request: CheckoutRequest): Promise<{ orderId: string; items: ReservedItem[] }> {
  return transaction(db, async (client) => {
    const ids = request.items.map((i) => i.productId).sort();
    const { rows: products } = await client.query<{ id: string; name: string; price_cents: number; currency: string; stock: number }>(
      "select id, name, price_cents, currency, stock from products where id = any($1) order by id for update",
      [ids],
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    const items: ReservedItem[] = [];
    for (const { productId, quantity } of request.items) {
      const product = byId.get(productId);
      if (!product) throw new HttpError(404, `Unknown product: ${productId}`);
      if (product.stock < quantity) {
        throw new HttpError(409, product.stock === 0 ? `${product.name} is sold out` : `Only ${product.stock} of ${product.name} left`);
      }
      items.push({ productId, name: product.name, quantity, unitPriceCents: product.price_cents, currency: product.currency });
    }
    const currencies = new Set(items.map((i) => i.currency));
    if (currencies.size > 1) throw new HttpError(400, "All products in an order must use the same currency");

    const total = items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
    const {
      rows: [order],
    } = await client.query<{ id: string }>("insert into orders (currency, total_cents, email) values ($1, $2, $3) returning id", [
      items[0]!.currency,
      total,
      request.email ?? null,
    ]);
    for (const item of items) {
      await client.query("update products set stock = stock - $2 where id = $1", [item.productId, item.quantity]);
      await client.query("insert into order_items (order_id, product_id, quantity, unit_price_cents) values ($1, $2, $3, $4)", [
        order!.id,
        item.productId,
        item.quantity,
        item.unitPriceCents,
      ]);
    }
    await client.query("insert into order_events (order_id, to_status, reason) values ($1, 'pending', 'checkout started')", [
      order!.id,
    ]);
    return { orderId: order!.id, items };
  });
}

/** Puts an order's reserved stock back. Called inside a transaction that also changes its status. */
export async function releaseStock(client: Client, orderId: string): Promise<void> {
  await client.query(
    `update products p set stock = p.stock + i.quantity
     from order_items i where i.order_id = $1 and i.product_id = p.id`,
    [orderId],
  );
}

export interface CheckoutSettings {
  publicUrl: string;
  expiresMinutes: number;
}

/**
 * Starts a checkout: reserves the stock, then creates the Stripe Checkout Session. The
 * session request carries an idempotency key derived from the order, so a retried request
 * returns the same session instead of creating a second one. If Stripe fails, the order is
 * cancelled and its stock released.
 */
export async function startCheckout(db: Db, stripe: Stripe, settings: CheckoutSettings, request: CheckoutRequest) {
  const { orderId, items } = await reserveOrder(db, request);
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        client_reference_id: orderId,
        metadata: { order_id: orderId },
        payment_intent_data: { metadata: { order_id: orderId } },
        customer_email: request.email,
        line_items: items.map((item) => ({
          quantity: item.quantity,
          price_data: { currency: item.currency, unit_amount: item.unitPriceCents, product_data: { name: item.name } },
        })),
        expires_at: Math.floor(Date.now() / 1000) + settings.expiresMinutes * 60,
        success_url: `${settings.publicUrl}/order.html?id=${orderId}`,
        cancel_url: `${settings.publicUrl}/?cancelled=${orderId}`,
      },
      { idempotencyKey: `checkout-${orderId}` },
    );
  } catch (error) {
    await transaction(db, async (client) => {
      if (await transition(client, orderId, "cancelled", "payment provider unavailable")) await releaseStock(client, orderId);
    });
    throw new HttpError(502, `Payment provider unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  await db.query("update orders set checkout_session_id = $2, updated_at = now() where id = $1", [orderId, session.id]);
  return { orderId, checkoutUrl: session.url };
}

/**
 * Cancels pending orders that never got a Checkout Session, which happens only if the
 * process stopped between reserving the stock and calling Stripe. Without this, their
 * stock would stay reserved forever.
 */
export async function releaseAbandoned(db: Db, olderThanMinutes = 10): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    "select id from orders where status = 'pending' and checkout_session_id is null and created_at < now() - make_interval(mins => $1)",
    [olderThanMinutes],
  );
  let released = 0;
  for (const { id } of rows) {
    await transaction(db, async (client) => {
      if (await transition(client, id, "cancelled", "abandoned before payment started")) {
        await releaseStock(client, id);
        released += 1;
      }
    });
  }
  return released;
}

export interface OrderView {
  id: string;
  status: OrderStatus;
  currency: string;
  totalCents: number;
  refundedCents: number;
  createdAt: Date;
  items: { productId: string; name: string; quantity: number; unitPriceCents: number }[];
}

export async function getOrder(db: Db | Client, id: string): Promise<OrderView | null> {
  const { rows } = await db.query(
    `select o.id, o.status, o.currency, o.total_cents, o.refunded_cents, o.created_at,
            coalesce(json_agg(json_build_object('productId', i.product_id, 'name', p.name, 'quantity', i.quantity,
              'unitPriceCents', i.unit_price_cents) order by i.product_id) filter (where i.product_id is not null), '[]') as items
     from orders o left join order_items i on i.order_id = o.id left join products p on p.id = i.product_id
     where o.id = $1 group by o.id`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    currency: row.currency,
    totalCents: row.total_cents,
    refundedCents: row.refunded_cents,
    createdAt: row.created_at,
    items: row.items,
  };
}

/**
 * Asks Stripe to refund an order, fully or in part. The order's status changes when Stripe
 * confirms the refund through the charge.refunded webhook, which is the source of truth.
 * The caller's idempotency key makes a repeated request (a double click, a retried call)
 * return the same refund instead of refunding twice.
 */
export async function requestRefund(db: Db, stripe: Stripe, orderId: string, amountCents: number | undefined, idempotencyKey: string) {
  const { rows } = await db.query<{ status: OrderStatus; payment_intent_id: string | null; total_cents: number; refunded_cents: number }>(
    "select status, payment_intent_id, total_cents, refunded_cents from orders where id = $1",
    [orderId],
  );
  const order = rows[0];
  if (!order) throw new HttpError(404, "Order not found");
  if ((order.status !== "paid" && order.status !== "partially_refunded") || !order.payment_intent_id) {
    throw new HttpError(409, `An order that is ${order.status.replace("_", " ")} cannot be refunded`);
  }
  const refundable = order.total_cents - order.refunded_cents;
  const amount = amountCents ?? refundable;
  if (amount > refundable) throw new HttpError(422, `At most ${refundable} cents can still be refunded`);
  const refund = await stripe.refunds.create(
    { payment_intent: order.payment_intent_id, amount, metadata: { order_id: orderId } },
    { idempotencyKey: `refund-${orderId}-${idempotencyKey}` },
  );
  return { refundId: refund.id, status: refund.status, amountCents: amount };
}
