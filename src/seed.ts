import type { Db } from "./db.ts";

export const PRODUCTS = [
  { id: "mug", name: "Stoneware mug", description: "Hand-glazed, 350 ml.", priceCents: 1800, stock: 25 },
  { id: "notebook", name: "Dot grid notebook", description: "A5, 160 pages, lay-flat binding.", priceCents: 1400, stock: 40 },
  { id: "tote", name: "Canvas tote", description: "Heavy cotton with an inside pocket.", priceCents: 2200, stock: 15 },
  { id: "poster", name: "Risograph poster", description: "A3, two colours, numbered edition.", priceCents: 3500, stock: 5 },
];

/** Adds the demo products. Existing products keep their stock. */
export async function seed(db: Db): Promise<void> {
  for (const p of PRODUCTS) {
    await db.query(
      `insert into products (id, name, description, price_cents, stock) values ($1, $2, $3, $4, $5)
       on conflict (id) do update set name = excluded.name, description = excluded.description, price_cents = excluded.price_cents`,
      [p.id, p.name, p.description, p.priceCents, p.stock],
    );
  }
}
