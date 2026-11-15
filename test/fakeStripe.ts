import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for the two Stripe API endpoints the app calls, so tests run without network
 * access or Stripe keys. Like Stripe, it returns the same object for a repeated
 * idempotency key, and it can fail on demand.
 */

export interface RecordedRequest {
  path: string;
  params: Record<string, string>;
  idempotencyKey: string | undefined;
}

export interface FakeStripe {
  port: number;
  requests: RecordedRequest[];
  /** The next n requests fail with a 500 error. */
  failNext(n: number): void;
  close(): Promise<void>;
}

const id = (prefix: string) => `${prefix}_test_${randomBytes(8).toString("hex")}`;

export async function startFakeStripe(): Promise<FakeStripe> {
  const requests: RecordedRequest[] = [];
  const byKey = new Map<string, unknown>();
  let failures = 0;

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString()));
    request.on("end", () => {
      const params = Object.fromEntries(new URLSearchParams(body));
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      requests.push({ path: request.url ?? "", params, idempotencyKey });
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json", "request-id": id("req") });
        response.end(JSON.stringify(payload));
      };
      if (failures > 0) {
        failures -= 1;
        return send(500, { error: { type: "api_error", message: "Stripe is having trouble" } });
      }
      if (idempotencyKey && byKey.has(idempotencyKey)) return send(200, byKey.get(idempotencyKey));

      let result: unknown;
      if (request.method === "POST" && request.url === "/v1/checkout/sessions") {
        const sessionId = id("cs");
        result = { id: sessionId, object: "checkout.session", url: `https://checkout.stripe.test/c/pay/${sessionId}`, status: "open" };
      } else if (request.method === "POST" && request.url === "/v1/refunds") {
        result = { id: id("re"), object: "refund", status: "pending", amount: Number(params.amount) };
      } else {
        return send(404, { error: { type: "invalid_request_error", message: `No fake for ${request.method} ${request.url}` } });
      }
      if (idempotencyKey) byKey.set(idempotencyKey, result);
      send(200, result);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    failNext: (n) => {
      failures = n;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
