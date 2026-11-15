# Design decisions

Payments go wrong in the gaps between systems: a crash after one step and before the next, a message delivered twice, two messages in the wrong order, two customers at the same moment. These are the decisions that close those gaps, and the tests that check each one.

## The customer never sets the price

The checkout request names products and quantities only. Prices come from the database when the order is created and are sent to Stripe from there; a price in the request is ignored. When the payment is confirmed, the amount Stripe reports must equal the order total, or the webhook fails loudly.

*Tests:* `charges database prices…`, `refuses a payment that does not match the order total…`

## Stock is reserved at checkout, under a row lock

Starting a checkout locks the product rows (`select … for update`, in id order so concurrent checkouts never deadlock), checks the stock, decrements it and records the order, all in one transaction. A customer who reaches Stripe has their items held; one who doesn't pay gets them released when the session expires.

*Test:* twelve simultaneous checkouts for the last five posters sell exactly five. Without the lock, the same test oversells.

## The order is recorded before Stripe is called

The order and its reservation are committed first, then the Checkout Session is created. That leaves three cases:

- Stripe succeeds: the session id is saved on the order.
- Stripe fails: the order is cancelled and its stock released, and the customer sees a clear error.
- The process dies in between: the order has no session. A sweeper releases such orders after ten minutes.

The session request carries the idempotency key `checkout-<order id>`. The Stripe client retries network failures automatically, and the key makes a retry return the first session instead of creating a second one.

*Tests:* `cancels the order and releases the stock when Stripe is unavailable`, `retries a failed Stripe request with the same idempotency key`, `releases stock of orders abandoned before reaching Stripe`.

## Webhooks are the source of truth

The customer's redirect back to the shop proves nothing: they may close the tab first, or forge the URL. An order becomes paid only when Stripe says so through a signed webhook.

- **Signatures** are checked over the raw request body, before the JSON is read. The webhook route keeps the body unparsed for that reason.
- **Duplicates:** Stripe delivers each event at least once. Each event id is inserted into `stripe_events` in the same transaction that applies the event, so a second delivery finds the id and does nothing.
- **Failures are retried:** if applying an event fails, the transaction rolls back, the event id is not stored, and the 500 response makes Stripe deliver it again later.
- **Order is not guaranteed.** Status changes go through a table of allowed transitions. A late `checkout.session.expired` cannot cancel an order that is already paid.
- **Payload shape** is validated, field by field, for the fields this code reads. A change in Stripe's payloads fails loudly instead of writing bad data.

*Tests:* signatures (missing, wrong, tampered), the same event twice, expiry after payment, and a refund event that arrives before its payment.

## Edge cases with money already taken

- **A payment that completes after its order was cancelled** (the customer paid at the last second, or a delayed payment method settled late): the money is real, so the order becomes paid and the stock is taken again. If someone else has bought it meanwhile, the order is flagged *needs attention* in its history instead of failing.
- **Delayed payment methods** (bank debits) complete the checkout before the money arrives. Those orders stay pending until `checkout.session.async_payment_succeeded`, and are cancelled with their stock released on `async_payment_failed`.

## Refunds are requested by the shop and confirmed by Stripe

The admin endpoint asks Stripe for a refund and returns 202. It requires an `Idempotency-Key` header, passed on to Stripe, so a double click or a retried request refunds once.

The order's status changes only when the `charge.refunded` webhook arrives. That event carries `amount_refunded`, Stripe's running total for the charge, and the order stores that total rather than adding amounts up. A duplicate refund event, or a partial refund event arriving after the full one, therefore changes nothing.

*Tests:* partial then full refunds, refund events out of order, a repeated refund request returning the same refund.

## Testing without Stripe

The tests run against a small fake of the two Stripe endpoints used, served on a local port. Like Stripe, it returns the same object for a repeated idempotency key, and it can fail on demand to test outages. Webhook payloads are signed with the Stripe library's own test helper, so signature verification runs for real.

What the fake does not cover is Stripe's own behaviour; the README describes running against Stripe's test mode with the Stripe CLI.

## Everything else is deliberately simple

- One PostgreSQL database holds products, orders, handled events and the audit trail, with plain SQL migrations.
- Every status change is written to `order_events` with its reason, for support and audits.
- Admin endpoints use a bearer token compared in constant time. A real shop would put them behind its staff login.
