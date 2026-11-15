import Stripe from "stripe";

export interface StripeOptions {
  /** Points the client at another server, used by the tests' fake Stripe. */
  host?: string;
  port?: number;
  protocol?: "http" | "https";
}

export function createStripe(secretKey: string, options: StripeOptions = {}): Stripe {
  return new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000, ...options });
}
