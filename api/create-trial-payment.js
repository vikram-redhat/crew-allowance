/**
 * /api/create-trial-payment.js
 *
 * Creates a one-time Stripe PaymentIntent for the ₹100 trial.
 * Returns a clientSecret the browser uses to confirm payment via the
 * Payment Element (same UI as the subscription checkout — supports card + UPI).
 *
 * On success, the webhook (payment_intent.succeeded) sets profiles.trial_paid_at.
 *
 * Required env vars:
 *   STRIPE_SECRET_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const TRIAL_AMOUNT_INR = 100; // ₹100 — server-side authoritative

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY is not configured." });

  const { userId, email } = req.body || {};
  if (!userId || !email) return res.status(400).json({ error: "userId and email are required." });

  const supa = serviceSupabase();
  if (!supa) return res.status(500).json({ error: "Supabase not configured." });

  // Don't let someone buy a trial twice (refund-friendly: also blocks if they
  // already have an active subscription).
  const { data: profile } = await supa
    .from("profiles")
    .select("stripe_customer_id, trial_paid_at, subscription_status")
    .eq("id", userId)
    .maybeSingle();

  if (profile?.trial_paid_at) {
    return res.status(400).json({ error: "Trial already purchased on this account." });
  }
  if (["active", "trialing"].includes(profile?.subscription_status)) {
    return res.status(400).json({ error: "This account already has an active subscription." });
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2023-10-16" });

  try {
    // Reuse / create Stripe Customer (same pattern as subscription path).
    let customerId = profile?.stripe_customer_id || null;
    if (!customerId) {
      const customer = await stripe.customers.create({ email, metadata: { userId } });
      customerId = customer.id;
      await supa.from("profiles").update({ stripe_customer_id: customerId }).eq("id", userId);
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount:           TRIAL_AMOUNT_INR * 100,  // paise
      currency:         "inr",
      customer:         customerId,
      automatic_payment_methods: { enabled: true },   // surfaces card, UPI, etc.
      description:      "Crew Allowance — One-time trial (1 calculation)",
      metadata:         { userId, kind: "trial" },
    });

    // Stash the intent id so the webhook can match it back to this user.
    await supa.from("profiles").update({
      trial_payment_intent_id: paymentIntent.id,
    }).eq("id", userId);

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (err) {
    console.error("Stripe create-trial-payment error:", err);
    return res.status(500).json({ error: err.message });
  }
}

function serviceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
