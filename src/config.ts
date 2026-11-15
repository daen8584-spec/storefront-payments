import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgresql://localhost/storefront"),
  PORT: z.coerce.number().int().positive().default(3000),
  // The address customers come back to after paying, used in Stripe Checkout links.
  PUBLIC_URL: z.url().default("http://localhost:3000"),
  STRIPE_SECRET_KEY: z.string().startsWith("sk_", "STRIPE_SECRET_KEY must be a Stripe secret key (sk_test_...)"),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_", "STRIPE_WEBHOOK_SECRET must start with whsec_"),
  // Protects the admin endpoints (refunds, order list). At least 24 characters.
  ADMIN_TOKEN: z.string().min(24, "ADMIN_TOKEN must be at least 24 characters"),
  // Minutes a customer has to pay before the checkout expires and the stock is released.
  CHECKOUT_EXPIRES_MINUTES: z.coerce.number().int().min(30).max(1440).default(30),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
  }
  return result.data;
}
