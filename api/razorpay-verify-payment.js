/**
 * /api/razorpay-verify-payment.js
 *
 * Called by the Razorpay Checkout `handler` callback after a successful
 * payment. Verifies the signature server-side and applies an optimistic
 * profile update so the user sees "active" immediately.
 *
 * The webhook (/api/razorpay-webhook) is the authoritative source — this
 * endpoint exists purely so the success page doesn't have to wait for the
 * webhook to land.
 *
 * Two payment flavors are supported, distinguished by `kind`:
 *
 *   1. kind: "trial"        — body has razorpay_order_id + razorpay_payment_id.
 *      Signature = HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET).
 *
 *   2. kind: "subscription" — body has razorpay_subscription_id + razorpay_payment_id.
 *      Signature = HMAC_SHA256(payment_id + "|" + subscription_id, KEY_SECRET).
 *
 * Required env vars:
 *   RAZORPAY_KEY_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { requireAuthedUser } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return res.status(500).json({ error: "RAZORPAY_KEY_SECRET is not configured." });

  const {
    kind,
    userId,
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_subscription_id,
    razorpay_signature,
  } = req.body || {};

  if (!razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  // CRITICAL: verify the caller's JWT matches the userId they're flipping.
  // The HMAC signature only covers Razorpay-issued IDs (order/payment/sub),
  // it does NOT bind userId. Without this check, an attacker who observes
  // any legitimate (payment_id, signature) pair from one of their own
  // payments could re-POST those same fields with a victim's userId and
  // grant the victim a fake "paid" status. See HANDOFF §15.1 / §16.1.
  const auth = await requireAuthedUser(req, userId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // Build the canonical signed string per Razorpay's spec.
  let signedPayload;
  if (kind === "trial") {
    if (!razorpay_order_id) return res.status(400).json({ error: "razorpay_order_id is required for trial." });
    signedPayload = `${razorpay_order_id}|${razorpay_payment_id}`;
  } else if (kind === "subscription") {
    if (!razorpay_subscription_id) return res.status(400).json({ error: "razorpay_subscription_id is required for subscription." });
    signedPayload = `${razorpay_payment_id}|${razorpay_subscription_id}`;
  } else {
    return res.status(400).json({ error: "kind must be 'trial' or 'subscription'." });
  }

  const expectedSig = crypto
    .createHmac("sha256", keySecret)
    .update(signedPayload)
    .digest("hex");

  // Constant-time compare to avoid leaking timing info on the secret.
  const sigBuf = Buffer.from(razorpay_signature, "utf8");
  const expBuf = Buffer.from(expectedSig, "utf8");
  const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

  if (!valid) {
    return res.status(400).json({ error: "Signature verification failed." });
  }

  const supa = serviceSupabase();
  if (!supa) return res.status(500).json({ error: "Supabase not configured." });

  try {
    if (kind === "trial") {
      // Optimistic — webhook payment.captured will reaffirm.
      const { error } = await supa.from("profiles").update({
        is_active:           true,
        trial_paid_at:       new Date().toISOString(),
        trial_used:          false,
        razorpay_order_id,
        razorpay_payment_id,
        payment_provider:    "razorpay",
      }).eq("id", userId);
      if (error) return res.status(500).json({ error: error.message });
    } else {
      // Subscription: mark active optimistically. The webhook will fill in
      // current_period_end and the canonical status.
      const { error } = await supa.from("profiles").update({
        is_active:                true,
        subscription_status:      "active",
        razorpay_subscription_id,
        razorpay_payment_id,
        payment_provider:         "razorpay",
      }).eq("id", userId);
      if (error) return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Razorpay verify-payment error:", err);
    return res.status(500).json({ error: err.message });
  }
}

function serviceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
