/**
 * /api/razorpay-cancel-subscription.js
 *
 * Cancels the user's Razorpay Subscription at the end of the current billing
 * cycle. The user keeps access until `subscription_current_period_end`, then
 * the webhook (`subscription.cancelled` / `subscription.completed`) flips
 * `is_active` to false.
 *
 * Razorpay has no Stripe-style hosted Customer Portal, so this in-app
 * endpoint is the replacement. Updating the saved card / mandate is handled
 * by Razorpay via the email/SMS retry link sent on the next failed charge.
 *
 * Required env vars:
 *   RAZORPAY_KEY_ID
 *   RAZORPAY_KEY_SECRET
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import Razorpay from "razorpay";
import { createClient } from "@supabase/supabase-js";
import { requireAuthedUser } from "./_lib/auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    return res.status(500).json({ error: "Razorpay keys are not configured." });
  }

  const { userId } = req.body || {};

  // Verify the caller is who they claim to be — the JWT in the
  // Authorization header must decode to this userId. Without this,
  // any authenticated user could POST any other user's UUID and
  // cancel their subscription. See HANDOFF §15.1 / §16.1.
  const auth = await requireAuthedUser(req, userId);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return res.status(500).json({ error: "Supabase not configured." });
  }
  const supa = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  const { data: profile } = await supa
    .from("profiles")
    .select("razorpay_subscription_id, subscription_status")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.razorpay_subscription_id) {
    return res.status(400).json({ error: "No active subscription found for this account." });
  }
  if (["cancelled", "completed", "expired"].includes(profile.subscription_status)) {
    return res.status(400).json({ error: "Subscription is already cancelled." });
  }

  const razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });

  try {
    // cancel_at_cycle_end=1 → user keeps access until current_end. The
    // subscription.updated / subscription.cancelled webhook will reconcile
    // the status and the cancel_at_period_end flag.
    const sub = await razorpay.subscriptions.cancel(
      profile.razorpay_subscription_id,
      true,   // cancel_at_cycle_end
    );

    // Best-effort optimistic flip so the UI updates instantly.
    await supa.from("profiles").update({
      subscription_cancel_at_period_end: true,
      subscription_status:               sub.status || profile.subscription_status,
    }).eq("id", userId);

    return res.status(200).json({
      ok:     true,
      status: sub.status,
      endAt:  sub.end_at ? new Date(sub.end_at * 1000).toISOString() : null,
    });
  } catch (err) {
    console.error("Razorpay cancel-subscription error:", err);
    const msg = err?.error?.description || err.message || "Failed to cancel subscription.";
    return res.status(500).json({ error: msg });
  }
}
