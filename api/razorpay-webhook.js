/**
 * /api/razorpay-webhook.js
 *
 * Source-of-truth for trial + subscription state. Razorpay POSTs lifecycle
 * events here; we reconcile the profile row.
 *
 * Required Vercel env vars:
 *   RAZORPAY_WEBHOOK_SECRET   the secret you set on the Razorpay webhook
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Razorpay Dashboard setup (one-time):
 *   - Add endpoint: https://crewallowance.com/api/razorpay-webhook
 *   - Subscribe to events:
 *       payment.captured
 *       payment.failed
 *       subscription.activated
 *       subscription.charged
 *       subscription.updated
 *       subscription.cancelled
 *       subscription.completed
 *       subscription.halted
 *       subscription.paused
 *       subscription.resumed
 */

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// Vercel default body parser would corrupt the raw bytes Razorpay needs to
// verify the signature, so we disable it and read the buffer ourselves.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const whSecret    = process.env.RAZORPAY_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!whSecret || !supabaseUrl || !supabaseKey) {
    console.error("Razorpay webhook missing config");
    return res.status(500).end();
  }

  const supa = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers["x-razorpay-signature"];
    if (!sig) return res.status(400).send("Missing signature header");

    const expected = crypto
      .createHmac("sha256", whSecret)
      .update(rawBody)
      .digest("hex");

    const sigBuf = Buffer.from(String(sig), "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    const valid  = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!valid) {
      console.error("Razorpay webhook signature verification failed");
      return res.status(400).send("Invalid signature");
    }

    event = JSON.parse(rawBody.toString("utf8"));
  } catch (err) {
    console.error("Razorpay webhook parse error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.event) {
      case "payment.captured": {
        const pay = event.payload?.payment?.entity;
        if (!pay) break;
        // Trial payments are flagged via notes.kind = "trial". Subscription
        // invoice payments also produce payment.captured but they include a
        // subscription_id — let subscription.* events handle those.
        if (pay.notes?.kind === "trial" && pay.notes?.userId && !pay.subscription_id) {
          await supa.from("profiles").update({
            is_active:           true,
            trial_paid_at:       new Date().toISOString(),
            trial_used:          false,
            razorpay_order_id:   pay.order_id || null,
            razorpay_payment_id: pay.id,
            payment_provider:    "razorpay",
          }).eq("id", pay.notes.userId);
        }
        break;
      }

      case "payment.failed": {
        // Logged for visibility; no profile change needed (the user's status
        // will only change when a subscription event comes through, e.g.
        // subscription.halted after repeated failures).
        const pay = event.payload?.payment?.entity;
        console.warn("Razorpay payment.failed", pay?.id, pay?.error_description);
        break;
      }

      case "subscription.activated":
      case "subscription.charged":
      case "subscription.updated":
      case "subscription.cancelled":
      case "subscription.completed":
      case "subscription.halted":
      case "subscription.paused":
      case "subscription.resumed": {
        const sub = event.payload?.subscription?.entity;
        if (sub) await syncSubscription(supa, sub);
        break;
      }

      default:
        // Unhandled event types are fine — Razorpay just wants a 2xx.
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Razorpay webhook handler error:", err);
    return res.status(500).end();
  }
}

/**
 * Maps a Razorpay Subscription entity into our profiles row.
 * Looks up the user via notes.userId (set on creation) or by
 * razorpay_subscription_id / razorpay_customer_id as a fallback.
 */
async function syncSubscription(supa, sub) {
  let userId = sub.notes?.userId || null;
  if (!userId) userId = await lookupUserBySubscription(supa, sub.id);
  if (!userId && sub.customer_id) userId = await lookupUserByCustomer(supa, sub.customer_id);
  if (!userId) {
    console.warn("syncSubscription: no userId for sub", sub.id);
    return;
  }

  // Razorpay returns current_end as a unix timestamp (seconds).
  const periodEnd = sub.current_end
    ? new Date(sub.current_end * 1000).toISOString()
    : null;

  // is_active is true if Razorpay says the subscription is currently entitled
  // to service. `authenticated` = mandate set up but first charge not yet
  // captured; we treat it as active so the user isn't blocked between
  // checkout success and the first invoice landing.
  const isActive = ["active", "authenticated"].includes(sub.status);

  // cancelled with an end_at in the future = "cancel at period end" semantics.
  const cancelAtPeriodEnd =
    sub.status === "cancelled" && sub.end_at && sub.end_at * 1000 > Date.now()
      ? true
      : !!sub.cancel_at_cycle_end;

  const plan = sub.notes?.plan || null;

  const update = {
    razorpay_subscription_id:           sub.id,
    razorpay_customer_id:               sub.customer_id || null,
    subscription_status:                sub.status,
    subscription_current_period_end:    periodEnd,
    subscription_cancel_at_period_end:  cancelAtPeriodEnd,
    is_active:                          isActive,
    payment_provider:                   "razorpay",
  };
  if (plan) update.subscription_plan = plan;

  const { error } = await supa.from("profiles").update(update).eq("id", userId);
  if (error) console.error("syncSubscription update error:", error);
}

async function lookupUserBySubscription(supa, subId) {
  const { data } = await supa
    .from("profiles")
    .select("id")
    .eq("razorpay_subscription_id", subId)
    .maybeSingle();
  return data?.id || null;
}

async function lookupUserByCustomer(supa, customerId) {
  const { data } = await supa
    .from("profiles")
    .select("id")
    .eq("razorpay_customer_id", customerId)
    .maybeSingle();
  return data?.id || null;
}
