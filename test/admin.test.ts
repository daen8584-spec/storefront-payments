import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, checkout, type Harness, paidOrder, startHarness } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const refund = (orderId: string, options: { token?: string; key?: string; amountCents?: number } = {}) =>
  h.app.inject({
    method: "POST",
    url: `/api/admin/orders/${orderId}/refunds`,
    headers: {
      ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.key ? { "idempotency-key": options.key } : {}),
    },
    payload: options.amountCents ? { amountCents: options.amountCents } : {},
  });

describe("admin", () => {
  it("requires the admin token", async () => {
    const { orderId } = await paidOrder(h);
    expect((await refund(orderId, { key: "key-12345" })).statusCode).toBe(401);
    expect((await refund(orderId, { token: "wrong", key: "key-12345" })).statusCode).toBe(401);
    expect((await h.app.inject("/api/admin/orders")).statusCode).toBe(401);
    const list = await h.app.inject({ url: "/api/admin/orders", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(list.json()).toMatchObject([{ id: orderId, status: "paid" }]);
  });

  it("requires an idempotency key for refunds", async () => {
    const { orderId } = await paidOrder(h);
    const response = await refund(orderId, { token: ADMIN_TOKEN });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/Idempotency-Key/);
  });

  it("asks Stripe for a refund once, however often the request is repeated", async () => {
    const { orderId, paymentIntent } = await paidOrder(h);
    const first = await refund(orderId, { token: ADMIN_TOKEN, key: "refund-click-1", amountCents: 500 });
    const again = await refund(orderId, { token: ADMIN_TOKEN, key: "refund-click-1", amountCents: 500 });
    expect(first.statusCode).toBe(202);
    expect(again.json().refundId).toBe(first.json().refundId);
    const sent = h.fake.requests.filter((r) => r.path === "/v1/refunds");
    expect(sent[0]!.params).toMatchObject({ payment_intent: paymentIntent, amount: "500" });
    expect(sent[0]!.idempotencyKey).toBe(`refund-${orderId}-refund-click-1`);
  });

  it("refunds the rest of the order when no amount is given", async () => {
    const { orderId, total } = await paidOrder(h);
    expect((await refund(orderId, { token: ADMIN_TOKEN, key: "refund-all-1" })).json()).toMatchObject({ amountCents: total });
  });

  it("refuses refunds that are not possible", async () => {
    const { body } = await checkout(h, [{ productId: "mug", quantity: 1 }]);
    expect((await refund(body.orderId, { token: ADMIN_TOKEN, key: "refund-pending" })).statusCode).toBe(409);

    const { orderId, total } = await paidOrder(h);
    const tooMuch = await refund(orderId, { token: ADMIN_TOKEN, key: "refund-too-much", amountCents: total + 1 });
    expect(tooMuch.statusCode).toBe(422);
    expect((await refund("00000000-0000-4000-8000-000000000000", { token: ADMIN_TOKEN, key: "refund-missing" })).statusCode).toBe(404);
  });

  it("keeps an audit trail of every status change", async () => {
    const { orderId } = await paidOrder(h);
    const response = await h.app.inject({ url: `/api/admin/orders/${orderId}/events`, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
    expect(response.json().map((e: { to: string }) => e.to)).toEqual(["pending", "paid"]);
  });
});
