import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { charge, checkout, deliver, type Harness, orderRow, paidOrder, session, signedEvent, startHarness, stock } from "./harness.ts";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const events = async (orderId: string) =>
  (await h.db.query("select to_status, reason from order_events where order_id = $1 order by id", [orderId])).rows;

describe("webhook signatures", () => {
  it("rejects a missing, wrong or tampered signature before reading the event", async () => {
    const { body } = await checkout(h, [{ productId: "mug", quantity: 1 }]);
    const { payload, signature } = signedEvent(h.stripe, "checkout.session.completed", session(body.orderId, { amount_total: 1800 }));
    const post = (headers: Record<string, string>, data = payload) =>
      h.app.inject({ method: "POST", url: "/webhooks/stripe", headers: { "content-type": "application/json", ...headers }, payload: data });

    expect((await post({})).statusCode).toBe(400);
    expect((await post({ "stripe-signature": "t=1,v1=deadbeef" })).statusCode).toBe(400);
    expect((await post({ "stripe-signature": signature }, payload.replace('"amount_total":1800', '"amount_total":1'))).statusCode).toBe(400);
    expect((await orderRow(h, body.orderId)).status).toBe("pending");
    expect((await post({ "stripe-signature": signature })).statusCode).toBe(200);
  });
});

describe("payments", () => {
  it("marks the order paid when the checkout completes", async () => {
    const { orderId, paymentIntent } = await paidOrder(h);
    expect(await orderRow(h, orderId)).toMatchObject({ status: "paid", payment_intent_id: paymentIntent });
    expect(await events(orderId)).toEqual([
      { to_status: "pending", reason: "checkout started" },
      { to_status: "paid", reason: "payment received (checkout.session.completed)" },
    ]);
  });

  it("handles the same event delivered twice only once", async () => {
    const { body } = await checkout(h, [{ productId: "mug", quantity: 1 }]);
    const event = session(body.orderId, { amount_total: 1800 });
    const first = await deliver(h, "checkout.session.completed", event, "evt_same");
    const second = await deliver(h, "checkout.session.completed", event, "evt_same");
    expect(first.json()).toMatchObject({ duplicate: false, applied: true });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true });
    expect(await events(body.orderId)).toHaveLength(2);
  });

  it("cancels an expired checkout and releases its stock", async () => {
    const { body } = await checkout(h, [{ productId: "poster", quantity: 2 }]);
    expect(await stock(h, "poster")).toBe(3);
    await deliver(h, "checkout.session.expired", session(body.orderId, { payment_status: "unpaid", payment_intent: null }));
    expect((await orderRow(h, body.orderId)).status).toBe("cancelled");
    expect(await stock(h, "poster")).toBe(5);
  });

  it("ignores an expiry that arrives after the payment", async () => {
    const { orderId } = await paidOrder(h, [{ productId: "poster", quantity: 1 }]);
    const response = await deliver(h, "checkout.session.expired", session(orderId, { payment_status: "unpaid" }));
    expect(response.json()).toMatchObject({ applied: false });
    expect((await orderRow(h, orderId)).status).toBe("paid");
    expect(await stock(h, "poster")).toBe(4);
  });

  it("accepts a payment that completes after the order was cancelled and takes the stock again", async () => {
    const { body } = await checkout(h, [{ productId: "poster", quantity: 2 }]);
    await deliver(h, "checkout.session.expired", session(body.orderId, { payment_status: "unpaid", payment_intent: null }));
    await deliver(h, "checkout.session.completed", session(body.orderId, { amount_total: 7000 }));
    expect((await orderRow(h, body.orderId)).status).toBe("paid");
    expect(await stock(h, "poster")).toBe(3);
  });

  it("flags a late payment whose stock has been sold to someone else", async () => {
    const { body } = await checkout(h, [{ productId: "poster", quantity: 5 }]);
    await deliver(h, "checkout.session.expired", session(body.orderId, { payment_status: "unpaid", payment_intent: null }));
    await checkout(h, [{ productId: "poster", quantity: 5 }]);
    await deliver(h, "checkout.session.completed", session(body.orderId, { amount_total: 17500 }));
    expect((await orderRow(h, body.orderId)).status).toBe("paid");
    expect(await stock(h, "poster")).toBe(0);
    expect((await events(body.orderId)).at(-1)!.reason).toBe("needs attention: paid after cancellation and out of stock for poster");
  });

  it("waits for delayed payment methods to succeed", async () => {
    const { body } = await checkout(h, [{ productId: "mug", quantity: 1 }]);
    await deliver(h, "checkout.session.completed", session(body.orderId, { amount_total: 1800, payment_status: "unpaid" }));
    expect((await orderRow(h, body.orderId)).status).toBe("pending");
    await deliver(h, "checkout.session.async_payment_succeeded", session(body.orderId, { amount_total: 1800 }));
    expect((await orderRow(h, body.orderId)).status).toBe("paid");
  });

  it("cancels and releases stock when a delayed payment fails", async () => {
    const { body } = await checkout(h, [{ productId: "tote", quantity: 1 }]);
    await deliver(h, "checkout.session.completed", session(body.orderId, { amount_total: 2200, payment_status: "unpaid" }));
    await deliver(h, "checkout.session.async_payment_failed", session(body.orderId, { payment_status: "unpaid" }));
    expect((await orderRow(h, body.orderId)).status).toBe("cancelled");
    expect(await stock(h, "tote")).toBe(15);
  });

  it("refuses a payment that does not match the order total, and stores nothing so it can be retried", async () => {
    const { body } = await checkout(h, [{ productId: "mug", quantity: 1 }]);
    const response = await deliver(h, "checkout.session.completed", session(body.orderId, { amount_total: 1 }), "evt_wrong");
    expect(response.statusCode).toBe(500);
    expect((await orderRow(h, body.orderId)).status).toBe("pending");
    const { rows } = await h.db.query("select * from stripe_events where id = 'evt_wrong'");
    expect(rows).toEqual([]);
  });

  it("records and ignores event types it does not handle", async () => {
    const response = await deliver(h, "customer.created", { id: "cus_1", object: "customer" });
    expect(response.json()).toMatchObject({ duplicate: false, applied: false });
  });
});

describe("refunds through webhooks", () => {
  it("applies partial then full refunds from Stripe's running total", async () => {
    const { orderId, total, paymentIntent } = await paidOrder(h);
    await deliver(h, "charge.refunded", charge(paymentIntent, 1000));
    expect(await orderRow(h, orderId)).toMatchObject({ status: "partially_refunded", refunded_cents: 1000 });
    await deliver(h, "charge.refunded", charge(paymentIntent, total));
    expect(await orderRow(h, orderId)).toMatchObject({ status: "refunded", refunded_cents: total });
  });

  it("is not confused by refund events arriving out of order", async () => {
    const { orderId, total, paymentIntent } = await paidOrder(h);
    await deliver(h, "charge.refunded", charge(paymentIntent, total), "evt_full");
    const late = await deliver(h, "charge.refunded", charge(paymentIntent, 1000), "evt_partial");
    expect(late.json()).toMatchObject({ applied: false });
    expect(await orderRow(h, orderId)).toMatchObject({ status: "refunded", refunded_cents: total });
  });

  it("asks Stripe to retry a refund that arrives before the payment is recorded", async () => {
    const { body } = await checkout(h, [{ productId: "mug", quantity: 1 }]);
    const paid = session(body.orderId, { amount_total: 1800 });
    const early = await deliver(h, "charge.refunded", charge(paid.payment_intent as string, 1800), "evt_early");
    expect(early.statusCode).toBe(500);

    await deliver(h, "checkout.session.completed", paid);
    const retried = await deliver(h, "charge.refunded", charge(paid.payment_intent as string, 1800), "evt_early");
    expect(retried.json()).toMatchObject({ duplicate: false, applied: true });
    expect((await orderRow(h, body.orderId)).status).toBe("refunded");
  });
});
