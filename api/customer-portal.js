/**
 * /api/customer-portal.js
 *
 * Creates a Stripe Customer Portal session so the user can manage their
 * subscription (cancel, update card, view invoices) on Stripe's hosted UI.
 *
 * Required Vercel env vars:
 *   STRIPE_SECRET_KEY
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Stripe Dashboard setup (one-time):
 *   Settings → Billing → Customer Portal → Enable.
 *   Configure which actions are allowed (cancel, update payment method, etc.).
 */

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: "STRIPE_SECRET_KEY is not configured." });

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: "userId is required." });

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: "Supabase not configured." });

  const supa = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false } });

  // Look up the Stripe customer ID from the profile
  const { data: profile } = await supa
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.stripe_customer_id) {
    return res.status(400).json({ error: "No subscription found for this account." });
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2023-10-16" });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   profile.stripe_customer_id,
      return_url: req.headers.origin || "https://crewallowance.com",
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Customer portal error:", err);
    return res.status(500).json({ error: err.message });
  }
}
