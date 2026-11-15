// Storefront page and order page. Prices shown here are for display; the server
// computes the amount charged from its own prices.

const money = (cents, currency = "usd") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);

const text = (tag, content, className) => {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
};

async function shopPage() {
  const list = document.getElementById("products");
  const cartList = document.getElementById("cart-items");
  const cartEmpty = document.getElementById("cart-empty");
  const totalLabel = document.getElementById("cart-total");
  const checkoutButton = document.getElementById("checkout");
  const errorLabel = document.getElementById("checkout-error");
  const cart = new Map();

  const params = new URLSearchParams(location.search);
  if (params.has("cancelled")) {
    const notice = document.getElementById("notice");
    notice.textContent = "Payment cancelled. Nothing was charged, and your cart is still here.";
    notice.hidden = false;
  }

  const products = await (await fetch("/api/products")).json();
  list.removeAttribute("aria-busy");
  const byId = new Map(products.map((p) => [p.id, p]));
  try {
    for (const [id, quantity] of JSON.parse(sessionStorage.getItem("cart") ?? "[]")) if (byId.has(id)) cart.set(id, quantity);
  } catch {
    sessionStorage.removeItem("cart");
  }

  function render() {
    cartList.replaceChildren();
    let total = 0;
    for (const [id, quantity] of cart) {
      const product = byId.get(id);
      total += product.priceCents * quantity;
      const row = document.createElement("li");
      row.append(text("span", `${quantity} × ${product.name}`), text("span", money(product.priceCents * quantity, product.currency)));
      const remove = text("button", "Remove", "link-button");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${product.name}`);
      remove.addEventListener("click", () => {
        cart.delete(id);
        render();
      });
      row.append(remove);
      cartList.append(row);
    }
    cartEmpty.hidden = cart.size > 0;
    checkoutButton.disabled = cart.size === 0;
    totalLabel.textContent = money(total);
    sessionStorage.setItem("cart", JSON.stringify([...cart]));
  }

  for (const product of products) {
    const card = document.createElement("li");
    card.className = "product";
    card.append(text("h3", product.name), text("p", product.description, "muted"), text("p", money(product.priceCents, product.currency), "price"));
    const add = text("button", product.stock === 0 ? "Sold out" : "Add to cart", "button");
    add.type = "button";
    add.disabled = product.stock === 0;
    add.setAttribute("aria-label", product.stock === 0 ? `${product.name} is sold out` : `Add ${product.name} to cart`);
    add.addEventListener("click", () => {
      const quantity = Math.min((cart.get(product.id) ?? 0) + 1, Math.min(10, product.stock));
      cart.set(product.id, quantity);
      render();
    });
    if (product.stock > 0 && product.stock <= 5) card.append(text("p", `Only ${product.stock} left`, "low-stock"));
    card.append(add);
    list.append(card);
  }
  render();

  checkoutButton.addEventListener("click", async () => {
    checkoutButton.disabled = true;
    errorLabel.hidden = true;
    const email = document.getElementById("email").value.trim();
    const response = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [...cart].map(([productId, quantity]) => ({ productId, quantity })), ...(email ? { email } : {}) }),
    });
    const body = await response.json();
    if (!response.ok) {
      errorLabel.textContent = body.error ?? "Something went wrong. Please try again.";
      errorLabel.hidden = false;
      checkoutButton.disabled = false;
      return;
    }
    sessionStorage.removeItem("cart");
    location.assign(body.checkoutUrl);
  });
}

const STATUS_TEXT = {
  pending: "Waiting for the payment to be confirmed…",
  paid: "Paid. Thank you for your order!",
  cancelled: "This order was cancelled and nothing was charged.",
  refunded: "This order was refunded.",
  partially_refunded: "Part of this order was refunded.",
};

async function orderPage() {
  const container = document.getElementById("order");
  const id = new URLSearchParams(location.search).get("id");
  if (!id) {
    container.replaceChildren(text("p", "No order to show."));
    return;
  }
  // Stripe confirms payments through a webhook, which can arrive a few seconds after the
  // customer returns here, so the page checks again for a while.
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}`);
    if (!response.ok) {
      container.replaceChildren(text("p", "We couldn't find this order."));
      return;
    }
    const order = await response.json();
    const list = document.createElement("ul");
    for (const item of order.items) list.append(text("li", `${item.quantity} × ${item.name ?? item.productId} at ${money(item.unitPriceCents, order.currency)}`));
    container.replaceChildren(
      text("p", STATUS_TEXT[order.status] ?? order.status, `status ${order.status}`),
      list,
      text("p", `Total ${money(order.totalCents, order.currency)}`, "total"),
      text("p", `Order ${order.id}`, "muted small"),
    );
    if (order.status !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

if (document.getElementById("products")) shopPage();
else orderPage();
