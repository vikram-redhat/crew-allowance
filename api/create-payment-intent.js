/**
 * /api/create-payment-intent.js
 * Creates a Stripe PaymentIntent for the subscription fee.
 * STRIPE_SECRET_KEY must be set in Vercel environment variables (no VITE_ prefix).
 *
 * npm install stripe   ← run this in your project root first
 */

import Stripe from "stripe";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: "STRIPE_SECRET_KEY is not configured on the server." });
  }

  const stripe = new Stripe(secretKey, { apiVersion: "2023-10-16" });

  const { amount, discountCode, userId, email } = req.body;

  if (!amount || amount < 0) {
    return res.status(400).json({ error: "Invalid amount." });
  }

  // $0 payments don't need a PaymentIntent — handled client-side
  if (amount === 0) {
    return res.status(200).json({ free: true });
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount:   amount * 100,          // Stripe uses paise (smallest currency unit)
      currency: "inr",
      metadata: {
        userId:       userId  || "",
        email:        email   || "",
        discountCode: discountCode || "",
      },
      description: "Crew Allowance — Monthly Subscription",
    });

    return res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Stripe error:", err);
    return res.status(500).json({ error: err.message });
  }
}
