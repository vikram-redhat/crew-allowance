/**
 * /api/razorpay-create-order.js
 *
 * Creates a one-time Razorpay Order for the ₹100 trial. The browser uses the
 * returned order_id to open Standard Checkout; on success the handler posts
 * the payment back to /api/razorpay-verify-payment for HMAC verification.
 *
 * The webhook (payment.captured) is the authoritative source for marking the
 * trial as paid; this endpoint just kicks off the checkout.
 *
 * Required env vars:
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import Razorpay from "razorpay";
import { createClient } from "@supabase/supabase-js";

const TRIAL_AMOUNT_INR = 100; // ₹100 — server-side authoritative

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return res.status(500).json({ error: "Razorpay keys are not configured." });
  }

  const { userId, email } = req.body || {};
  if (!userId || !email) {
    return res.status(400).json({ error: "userId and email are required." });
  }

  const supa = serviceSupabase();
  if (!supa) return res.status(500).json({ error: "Supabase not configured." });

  // Same eligibility checks as the legacy Stripe trial endpoint — block the
  // user from buying a second trial or layering one on top of a live sub.
  const { data: profile } = await supa
    .from("profiles")
    .select("razorpay_customer_id, trial_paid_at, subscription_status")
    .eq("id", userId)
    .maybeSingle();

  if (profile?.trial_paid_at) {
    return res.status(400).json({ error: "Trial already purchased on this account." });
  }
  if (["active", "trialing", "authenticated"].includes(profile?.subscription_status)) {
    return res.status(400).json({ error: "This account already has an active subscription." });
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  try {
    // receipt has a 40-char limit on Razorpay; userId can be a 36-char UUID,
    // so we take a short prefix to leave room for "trial_".
    const receipt = `trial_${String(userId).replace(/-/g, "").slice(0, 32)}`;

    const order = await razorpay.orders.create({
      amount:   TRIAL_AMOUNT_INR * 100,  // paise
      currency: "INR",
      receipt,
      notes: {
        userId,
        kind: "trial",
      },
    });

    // Stash the order id so the webhook can reconcile if the verify-payment
    // call never makes it back to us.
    await supa.from("profiles").update({
      razorpay_order_id: order.id,
      payment_provider:  "razorpay",
    }).eq("id", userId);

    return res.status(200).json({
      orderId: order.id,
      keyId,                              // public key, safe to send to browser
      amount:  order.amount,              // paise
      currency: order.currency,
    });
  } catch (err) {
    console.error("Razorpay create-order error:", err);
    const msg = err?.error?.description || err.message || "Failed to create order.";
    return res.status(500).json({ error: msg });
  }
}

function serviceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
