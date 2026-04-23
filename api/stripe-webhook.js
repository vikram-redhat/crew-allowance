/**
 * /api/stripe-webhook.js
 *
 * Source-of-truth for subscription state. Stripe POSTs lifecycle events here;
 * we update the profile row accordingly.
 *
 * Required Vercel env vars:
 *   STRIPE_SECRET_KEY
 *   STRIPE_WEBHOOK_SECRET     whsec_...  (from Stripe Dashboard → Webhooks)
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Stripe Dashboard setup (one-time):
 *   - Add endpoint: https://crewallowance.com/api/stripe-webhook
 *   - Subscribe to events:
 *       customer.subscription.created
 *       customer.subscription.updated
 *       customer.subscription.deleted
 *       invoice.payment_succeeded
 *       invoice.payment_failed
 *       payment_intent.succeeded     ← needed for one-time trial purchases
 */

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Vercel default body parser would corrupt the raw bytes Stripe needs to verify
// the signature, so we disable it and read the buffer ourselves.
export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const secretKey   = process.env.STRIPE_SECRET_KEY;
  const whSecret    = process.env.STRIPE_WEBHOOK_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!secretKey || !whSecret || !supabaseUrl || !supabaseKey) {
    console.error("Webhook missing config");
    return res.status(500).end();
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2023-10-16" });
  const supa   = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  let event;
  try {
    const rawBody = await readRawBody(req);
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        await syncSubscription(stripe, supa, event.data.object);
        break;
      }

      case "invoice.payment_succeeded":
      case "invoice.payment_failed": {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          await syncSubscription(stripe, supa, sub);
        }
        break;
      }

      case "payment_intent.succeeded": {
        // Trial payments use a one-off PaymentIntent (kind: "trial" in metadata).
        // Subscription invoices also produce payment_intent.succeeded events,
        // but those have invoice attached — skip them here (handled above).
        const pi = event.data.object;
        if (pi.metadata?.kind === "trial" && pi.metadata?.userId && !pi.invoice) {
          await supa.from("profiles").update({
            is_active:      true,
            trial_paid_at:  new Date().toISOString(),
            trial_used:     false,
          }).eq("id", pi.metadata.userId);
        }
        break;
      }

      default:
        // Unhandled event types are fine — Stripe just wants a 2xx.
        break;
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).end();
  }
}

/**
 * Maps a Stripe Subscription object into our profiles row.
 * Looks up the user via metadata.userId (set on creation) or by stripe_customer_id.
 */
async function syncSubscription(stripe, supa, sub) {
  const userId = sub.metadata?.userId
    || (await lookupUserByCustomer(supa, sub.customer));
  if (!userId) {
    console.warn("syncSubscription: no userId for sub", sub.id);
    return;
  }

  const plan = sub.metadata?.plan || null;
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  // is_active is true if Stripe says the subscription is active or trialing.
  const isActive = ["active", "trialing"].includes(sub.status);

  const { error } = await supa.from("profiles").update({
    stripe_subscription_id:               sub.id,
    stripe_customer_id:                   sub.customer,
    subscription_status:                  sub.status,
    subscription_plan:                    plan,
    subscription_current_period_end:      periodEnd,
    subscription_cancel_at_period_end:    !!sub.cancel_at_period_end,
    is_active:                            isActive,
  }).eq("id", userId);

  if (error) console.error("syncSubscription update error:", error);
}

async function lookupUserByCustomer(supa, customerId) {
  const { data } = await supa
    .from("profiles")
    .select("id")
    .eq("stripe_customer_id", customerId)
    .maybeSingle();
  return data?.id || null;
}
