-- Products, orders and the Stripe events already handled (docs/decisions.md).

create table products (
    id          text primary key,
    name        text not null,
    description text not null default '',
    price_cents integer not null check (price_cents > 0),
    currency    text not null default 'usd',
    -- Units that can still be sold: stock is reserved when a checkout starts.
    stock       integer not null check (stock >= 0)
);

create type order_status as enum ('pending', 'paid', 'cancelled', 'refunded', 'partially_refunded');

create table orders (
    id                  uuid primary key default gen_random_uuid(),
    status              order_status not null default 'pending',
    currency            text not null,
    total_cents         integer not null check (total_cents > 0),
    refunded_cents      integer not null default 0 check (refunded_cents >= 0),
    email               text,
    checkout_session_id text unique,
    payment_intent_id   text unique,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table order_items (
    order_id         uuid not null references orders (id) on delete cascade,
    product_id       text not null references products (id),
    quantity         integer not null check (quantity > 0),
    unit_price_cents integer not null check (unit_price_cents > 0),
    primary key (order_id, product_id)
);

-- One row per Stripe event handled. Stripe delivers events at least once, so the same
-- event can arrive again; the primary key makes handling it a second time a no-op.
create table stripe_events (
    id          text primary key,
    type        text not null,
    order_id    uuid references orders (id),
    received_at timestamptz not null default now()
);

-- Every status change, for support and audits.
create table order_events (
    id          bigserial primary key,
    order_id    uuid not null references orders (id) on delete cascade,
    from_status order_status,
    to_status   order_status not null,
    reason      text not null,
    created_at  timestamptz not null default clock_timestamp()
);
