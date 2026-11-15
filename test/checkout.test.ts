import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { releaseAbandoned } from "../src/orders.ts";
import { checkout, type Harness, orderRow, startHarness, stock } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reset());

describe("checkout", () => {
  it("lists products with prices and stock", async () => {
    const response = await h.app.inject("/api/products");
    expect(response.json()).toContainEqual(expect.objectContaining({ id: "mug", priceCents: 1800, stock: 25 }));
  });

  it("charges database prices, reserves stock and creates one Stripe session per order", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/api/checkout",
      // A price sent by the client is ignored.
      payload: { items: [{ productId: "mug", quantity: 2, priceCents: 1 }, { productId: "tote", quantity: 1 }], email: "a@example.com" },
    });
    expect(response.statusCode).toBe(201);
    const { orderId, checkoutUrl } = response.json();
    expect(checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);

    const order = await orderRow(h, orderId);
    expect(order).toMatchObject({ status: "pending", total_cents: 2 * 1800 + 2200 });
    expect(order.checkout_session_id).toMatch(/^cs_test_/);
    expect(await stock(h, "mug")).toBe(23);
    expect(await stock(h, "tote")).toBe(14);

    const [sent] = h.fake.requests;
    expect(sent!.idempotencyKey).toBe(`checkout-${orderId}`);
    expect(sent!.params).toMatchObject({
      mode: "payment",
      client_reference_id: orderId,
      "line_items[0][price_data][unit_amount]": "1800",
      "line_items[0][quantity]": "2",
      "line_items[1][price_data][unit_amount]": "2200",
      customer_email: "a@example.com",
      success_url: `http://shop.test/order.html?id=${orderId}`,
    });
  });

  it.each([
    [{ items: [] }, 400],
    [{ items: [{ productId: "mug", quantity: 0 }] }, 400],
    [{ items: [{ productId: "mug", quantity: 11 }] }, 400],
    [{ items: [{ productId: "mug", quantity: 1 }, { productId: "mug", quantity: 1 }] }, 400],
    [{ items: [{ productId: "unicorn", quantity: 1 }] }, 404],
    [{ items: [{ productId: "poster", quantity: 6 }] }, 409],
  ])("rejects %j with %i and reserves nothing", async (payload, status) => {
    const response = await h.app.inject({ method: "POST", url: "/api/checkout", payload });
    expect(response.statusCode).toBe(status);
    expect(await stock(h, "poster")).toBe(5);
    expect(await stock(h, "mug")).toBe(25);
    expect(h.fake.requests).toHaveLength(0);
  });

  it("never sells more than the stock when customers check out at the same moment", async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, () => checkout(h, [{ productId: "poster", quantity: 1 }])));
    const statuses = attempts.map((a) => a.response.statusCode).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
    expect(await stock(h, "poster")).toBe(0);
  });

  it("cancels the order and releases the stock when Stripe is unavailable", async () => {
    h.fake.failNext(3); // the first attempt and both automatic retries
    const { response, body } = await checkout(h, [{ productId: "poster", quantity: 2 }]);
    expect(response.statusCode).toBe(502);
    expect(body.error).toMatch(/Payment provider unavailable/);
    expect(await stock(h, "poster")).toBe(5);
    const { rows } = await h.db.query("select status from orders");
    expect(rows).toEqual([{ status: "cancelled" }]);
  });

  it("retries a failed Stripe request with the same idempotency key", async () => {
    h.fake.failNext(1);
    const { response, body } = await checkout(h, [{ productId: "mug", quantity: 1 }]);
    expect(response.statusCode).toBe(201);
    expect(h.fake.requests.map((r) => r.idempotencyKey)).toEqual([`checkout-${body.orderId}`, `checkout-${body.orderId}`]);
  });

  it("releases stock of orders abandoned before reaching Stripe", async () => {
    // Simulates a crash after reserving stock but before creating the session.
    await h.db.query("update products set stock = stock - 3 where id = 'tote'");
    const {
      rows: [order],
    } = await h.db.query("insert into orders (currency, total_cents, created_at) values ('usd', 6600, now() - interval '1 hour') returning id");
    await h.db.query("insert into order_items (order_id, product_id, quantity, unit_price_cents) values ($1, 'tote', 3, 2200)", [order.id]);

    expect(await releaseAbandoned(h.db)).toBe(1);
    expect(await stock(h, "tote")).toBe(15);
    expect((await orderRow(h, order.id)).status).toBe("cancelled");
    expect(await releaseAbandoned(h.db)).toBe(0);
  });

  it("shows an order's status by its id", async () => {
    const { body } = await checkout(h, [{ productId: "notebook", quantity: 3 }]);
    const response = await h.app.inject(`/api/orders/${body.orderId}`);
    expect(response.json()).toMatchObject({
      status: "pending",
      totalCents: 4200,
      items: [{ productId: "notebook", name: "Dot grid notebook", quantity: 3, unitPriceCents: 1400 }],
    });
    expect((await h.app.inject("/api/orders/not-a-uuid")).statusCode).toBe(404);
    expect((await h.app.inject("/api/orders/00000000-0000-4000-8000-000000000000")).statusCode).toBe(404);
  });
});
