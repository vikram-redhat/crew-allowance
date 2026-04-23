/**
 * /api/create-subscription.js
 *
 * Creates (or reuses) a Stripe Customer for the user, then opens a Subscription
 * for the chosen plan. Returns a clientSecret the browser uses to confirm the
 * first payment via stripe.confirmCardPayment().
 *
 * Subscription lifecycle (renewals, failures, cancellations) is tracked via
 * /api/stripe-webhook — this endpoint only kicks off the initial checkout.
 *
 * Required Vercel env vars:
 *   STRIPE_SECRET_KEY         sk_live_... or sk_test_...
 *   STRIPE_PRICE_1MO          price_xxx for the ₹100/month plan
 *   STRIPE_PRICE_12MO         price_xxx for the ₹1,000/year plan
 *   FREE_ACCESS_CODE          a server-only secret string admins share with comp users
 *   SUPABASE_URL              for free-path activation
 *   SUPABASE_SERVICE_ROLE_KEY for free-path activation (server side; never exposed)
 */

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const PLAN_TO_ENV = {
  "1mo":  "STRIPE_PRICE_1MO",
  "12mo": "STRIPE_PRICE_12MO",
};

const PLAN_DURATION_MONTHS = { "1mo": 1, "12mo": 12 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY is not configured." });

  const { plan, userId, email, freeCode } = req.body || {};

  if (!plan || !PLAN_TO_ENV[plan]) {
    return res.status(400).json({ error: "Invalid plan. Must be '1mo' or '12mo'." });
  }
  if (!userId || !email) {
    return res.status(400).json({ error: "userId and email are required." });
  }

  // ─── Free-access path (no Stripe call) ──────────────────────────────────
  // Activates the user for the chosen plan duration. Used for comp accounts.
  if (freeCode) {
    const expected = process.env.FREE_ACCESS_CODE;
    if (!expected || freeCode !== expected) {
      return res.status(400).json({ error: "Invalid access code." });
    }
    const supa = serviceSupabase();
    if (!supa) return res.status(500).json({ error: "Supabase service role not configured." });

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + PLAN_DURATION_MONTHS[plan]);

    const { error } = await supa.from("profiles").update({
      is_active:                       true,
      subscription_plan:               "free",
      subscription_status:             "active",
      subscription_current_period_end: periodEnd.toISOString(),
    }).eq("id", userId);

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ free: true });
  }

  // ─── Paid path: create Customer + Subscription ──────────────────────────
  const priceId = process.env[PLAN_TO_ENV[plan]];
  if (!priceId) {
    return res.status(500).json({ error: `${PLAN_TO_ENV[plan]} is not configured.` });
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2023-10-16" });

  try {
    // Reuse an existing Customer if we have one for this user, else create.
    const supa = serviceSupabase();
    let customerId = null;
    if (supa) {
      const { data } = await supa
        .from("profiles")
        .select("stripe_customer_id")
        .eq("id", userId)
        .maybeSingle();
      customerId = data?.stripe_customer_id || null;
    }

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { userId },
      });
      customerId = customer.id;
      if (supa) {
        await supa.from("profiles").update({ stripe_customer_id: customerId }).eq("id", userId);
      }
    }

    // Create the Subscription in `default_incomplete` state — Stripe won't
    // activate it until the first invoice is paid via the returned clientSecret.
    const subscription = await stripe.subscriptions.create({
      customer:          customerId,
      items:             [{ price: priceId }],
      payment_behavior:  "default_incomplete",
      payment_settings:  { save_default_payment_method: "on_subscription" },
      expand:            ["latest_invoice.payment_intent"],
      metadata:          { userId, plan },
    });

    const paymentIntent = subscription.latest_invoice?.payment_intent;
    if (!paymentIntent?.client_secret) {
      return res.status(500).json({ error: "Stripe did not return a payment intent." });
    }

    return res.status(200).json({
      clientSecret:    paymentIntent.client_secret,
      subscriptionId:  subscription.id,
      customerId,
    });
  } catch (err) {
    console.error("Stripe create-subscription error:", err);
    return res.status(500).json({ error: err.message });
  }
}

function serviceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
