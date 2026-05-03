/**
 * /api/razorpay-create-subscription.js
 *
 * Two paths in one endpoint (matches the legacy Stripe handler so the front
 * end can keep the same call shape):
 *
 *   1. Free / comp path — `freeCode` is set. Verifies the secret and flips the
 *      profile to `active` immediately. No Razorpay call is made.
 *
 *   2. Paid path — creates (or reuses) a Razorpay Customer and a Subscription
 *      against RAZORPAY_PLAN_1MO / RAZORPAY_PLAN_12MO, returns the
 *      subscription_id + public key for the browser to open Checkout with.
 *      Lifecycle (charges, cancellations, retries) is reconciled by
 *      /api/razorpay-webhook.
 *
 * Required env vars:
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 *   RAZORPAY_PLAN_1MO         plan_xxx for ₹100/month
 *   RAZORPAY_PLAN_12MO        plan_xxx for ₹1000/year
 *   FREE_ACCESS_CODE          server-only secret for comp users
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import Razorpay from "razorpay";
import { createClient } from "@supabase/supabase-js";
import { requireAuthedUser } from "./_lib/auth.js";

const PLAN_TO_ENV = {
  "1mo":  "RAZORPAY_PLAN_1MO",
  "12mo": "RAZORPAY_PLAN_12MO",
};

// Razorpay Subscriptions require a finite total_count of billing cycles.
// We pick a long horizon so the user effectively has open-ended access until
// they cancel; after total_count cycles Razorpay marks the sub `completed`
// and they'd resubscribe. 120 monthly = 10 years, 10 yearly = 10 years.
const PLAN_TOTAL_COUNT = {
  "1mo":  120,
  "12mo": 10,
};

// Comp accounts can pick any plan (including the trial). Trial maps to 1mo
// of comp access — they're getting it free, no point limiting them to one run.
const COMP_PLAN_DURATION_MONTHS = { "trial": 1, "1mo": 1, "12mo": 12 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  const { plan, userId, email, freeCode } = req.body || {};
  if (!email) return res.status(400).json({ error: "email is required." });

  // Verify the caller's JWT matches the userId BEFORE any plan logic.
  // Both paths (comp and paid) need this — without it, a leaked
  // FREE_ACCESS_CODE could be replayed against any user's UUID to grant
  // them comp access, and the paid path could create subscriptions
  // against accounts that aren't the caller's. See HANDOFF §15.1 / §16.1.
  const auth = await requireAuthedUser(req, userId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // Comp path uses a permissive plan check (trial / 1mo / 12mo all OK).
  // Paid path requires a real Razorpay plan, so only 1mo / 12mo accepted.
  const isComp = !!freeCode;
  if (isComp && !COMP_PLAN_DURATION_MONTHS[plan]) {
    return res.status(400).json({ error: "Invalid plan." });
  }
  if (!isComp && !PLAN_TO_ENV[plan]) {
    return res.status(400).json({ error: "Invalid plan. Must be '1mo' or '12mo'." });
  }

  // ─── Free-access (comp) path — auto-approved ────────────────────────────
  // Comp users are activated immediately. If the code leaks, rotate the
  // FREE_ACCESS_CODE env var in Vercel — existing comp users keep working,
  // but new signups with the leaked code will be rejected.
  if (freeCode) {
    const expected = process.env.FREE_ACCESS_CODE;
    const norm = (s) => String(s || "").trim().toUpperCase();
    if (!expected || norm(freeCode) !== norm(expected)) {
      return res.status(400).json({ error: "Invalid access code." });
    }
    const supa = serviceSupabase();
    if (!supa) return res.status(500).json({ error: "Supabase service role not configured." });

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + COMP_PLAN_DURATION_MONTHS[plan]);

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
  if (!keyId || !keySecret) {
    return res.status(500).json({ error: "Razorpay keys are not configured." });
  }

  const planId = process.env[PLAN_TO_ENV[plan]];
  if (!planId) {
    return res.status(500).json({ error: `${PLAN_TO_ENV[plan]} is not configured.` });
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  const supa = serviceSupabase();

  try {
    // Reuse an existing Razorpay Customer if we have one for this user.
    let customerId = null;
    if (supa) {
      const { data } = await supa
        .from("profiles")
        .select("razorpay_customer_id")
        .eq("id", userId)
        .maybeSingle();
      customerId = data?.razorpay_customer_id || null;
    }

    if (!customerId) {
      try {
        const customer = await razorpay.customers.create({
          email,
          fail_existing: 0,        // if a customer with this email already exists, return it
          notes: { userId },
        });
        customerId = customer.id;
      } catch (err) {
        // Non-fatal: customer creation isn't strictly required for a Subscription
        // (we can pass notify_info instead). Log and continue.
        console.warn("Razorpay customer create failed:", err?.error?.description || err.message);
      }
      if (customerId && supa) {
        await supa.from("profiles").update({
          razorpay_customer_id: customerId,
          payment_provider:     "razorpay",
        }).eq("id", userId);
      }
    }

    // Create the Subscription. The user authorises payment at Checkout (UPI
    // Autopay / e-mandate / card mandate); Razorpay then debits on schedule.
    const subPayload = {
      plan_id:         planId,
      total_count:     PLAN_TOTAL_COUNT[plan],
      customer_notify: 1,
      notes: {
        userId,
        plan,
        email,
      },
    };
    if (customerId) subPayload.customer_id = customerId;

    const subscription = await razorpay.subscriptions.create(subPayload);

    if (supa) {
      await supa.from("profiles").update({
        razorpay_subscription_id: subscription.id,
        subscription_plan:        plan,
        subscription_status:      subscription.status,  // 'created' until authenticated
        payment_provider:         "razorpay",
      }).eq("id", userId);
    }

    return res.status(200).json({
      subscriptionId: subscription.id,
      keyId,                    // public key for Checkout
      customerId:     customerId || null,
    });
  } catch (err) {
    console.error("Razorpay create-subscription error:", err);
    const msg = err?.error?.description || err.message || "Failed to create subscription.";
    return res.status(500).json({ error: msg });
  }
}

function serviceSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}
