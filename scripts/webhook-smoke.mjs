// scripts/webhook-smoke.mjs
//
// Manual tests for the Midtrans webhook (PRD P6). Run from server/:
//   node scripts/webhook-smoke.mjs forged  [baseUrl]
//   node scripts/webhook-smoke.mjs bad     [baseUrl]
//   node scripts/webhook-smoke.mjs unknown [baseUrl]
//   node scripts/webhook-smoke.mjs replay  <orderId> <grossAmount> [baseUrl]
//   node scripts/webhook-smoke.mjs expire  <orderId>
//
// baseUrl defaults to http://localhost:3000. Pass the tunnel URL to test the public path.
// grossAmount is the string Midtrans sends, e.g. "15000.00".
// Reads MIDTRANS_SERVER_KEY from .env and never prints it. Sandbox only.
import "dotenv/config";
import { createHash } from "node:crypto";

const [mode, ...args] = process.argv.slice(2);
const serverKey = (process.env.MIDTRANS_SERVER_KEY ?? "").trim();

if (process.env.MIDTRANS_IS_PRODUCTION === "true") {
  console.error("Refusing to run: MIDTRANS_IS_PRODUCTION=true. Sandbox only.");
  process.exit(1);
}

const needKey = () => {
  if (!serverKey) {
    console.error("MIDTRANS_SERVER_KEY is empty (run this from server/ so .env is found)");
    process.exit(1);
  }
};

const sign = (orderId, statusCode, gross) =>
  createHash("sha512")
    .update(orderId + statusCode + gross + serverKey)
    .digest("hex");

const baseAt = (i) => args[i] ?? "http://localhost:3000";

async function post(base, body) {
  const url = `${base.replace(/\/+$/, "")}/api/payments/midtrans/notification`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual", // Midtrans treats 301/302/303 as a failed delivery, so show them
    signal: AbortSignal.timeout(15_000),
  });
  const location = res.headers.get("location");
  console.log(`HTTP ${res.status}${location ? ` (REDIRECT to ${location})` : ""}`);
  console.log((await res.text()).slice(0, 300));
}

switch (mode) {
  case "forged": {
    // wrong signature: expect 403, nothing changes
    await post(baseAt(0), {
      order_id: "BAI-TEST",
      status_code: "200",
      gross_amount: "15000.00",
      transaction_status: "settlement",
      signature_key: "deadbeef",
    });
    break;
  }

  case "bad": {
    // not a notification at all: expect 400
    await post(baseAt(0), { hello: "world" });
    break;
  }

  case "unknown": {
    // valid signature, order that does not exist: expect 404
    needKey();
    const orderId = "BAI-000000-doesNotExist";
    await post(baseAt(0), {
      order_id: orderId,
      status_code: "200",
      gross_amount: "15000.00",
      transaction_status: "settlement",
      signature_key: sign(orderId, "200", "15000.00"),
    });
    break;
  }

  case "replay": {
    // valid signature for a REAL order that is already paid: expect 200 and "stale"
    needKey();
    const [orderId, gross] = args;
    if (!orderId || !gross) {
      console.error('usage: replay <orderId> <grossAmount e.g. "15000.00"> [baseUrl]');
      process.exit(1);
    }
    await post(baseAt(2), {
      order_id: orderId,
      status_code: "200",
      gross_amount: gross,
      transaction_status: "settlement",
      payment_type: "credit_card",
      signature_key: sign(orderId, "200", gross),
    });
    break;
  }

  case "expire": {
    // asks the Midtrans SANDBOX to expire a pending order, which then sends us an "expire" webhook
    needKey();
    const [orderId] = args;
    if (!orderId) {
      console.error("usage: expire <orderId>");
      process.exit(1);
    }
    const res = await fetch(
      `https://api.sandbox.midtrans.com/v2/${encodeURIComponent(orderId)}/expire`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`${serverKey}:`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    const body = await res.json().catch(() => ({}));
    console.log(
      `HTTP ${res.status} | status_code=${body.status_code} transaction_status=${body.transaction_status} message=${body.status_message}`,
    );
    break;
  }

  default:
    console.error(
      "modes: forged | bad | unknown | replay <orderId> <gross> | expire <orderId>   (last arg: optional baseUrl)",
    );
    process.exit(1);
}
