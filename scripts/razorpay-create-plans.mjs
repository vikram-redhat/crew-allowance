/**
 * scripts/razorpay-create-plans.mjs
 *
 * One-off helper to create the two recurring Plans on Razorpay (₹100/month
 * and ₹1000/year) and print the plan_ids so you can paste them into Vercel
 * as RAZORPAY_PLAN_1MO and RAZORPAY_PLAN_12MO.
 *
 * Run once per environment (test, then live):
 *   RAZORPAY_KEY_ID=rzp_test_xxx \
 *   RAZORPAY_KEY_SECRET=yyy \
 *   node scripts/razorpay-create-plans.mjs
 *
 * Plans on Razorpay are immutable — the only way to change the price is to
 * create a new plan. If you re-run this script you'll create duplicate plans;
 * delete the unused ones in the Razorpay Dashboard or skip re-running.
 */

import Razorpay from "razorpay";

const KEY_ID     = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

if (!KEY_ID || !KEY_SECRET) {
  console.error("ERROR: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in env.");
  process.exit(1);
}

const razorpay = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });

const PLANS = [
  {
    envName: "RAZORPAY_PLAN_1MO",
    period:  "monthly",
    interval: 1,
    item: {
      name:        "Crew Allowance — Monthly",
      description: "Unlimited reports, billed monthly",
      amount:      100 * 100,   // ₹100 in paise
      currency:    "INR",
    },
  },
  {
    envName: "RAZORPAY_PLAN_12MO",
    period:  "yearly",
    interval: 1,
    item: {
      name:        "Crew Allowance — Annual",
      description: "Unlimited reports, billed annually (save 17%)",
      amount:      1000 * 100,  // ₹1000 in paise
      currency:    "INR",
    },
  },
];

console.log(`\nCreating ${PLANS.length} plans on Razorpay (key: ${KEY_ID.slice(0, 12)}...)\n`);

const results = [];
for (const planCfg of PLANS) {
  try {
    const plan = await razorpay.plans.create({
      period:   planCfg.period,
      interval: planCfg.interval,
      item:     planCfg.item,
    });
    results.push({ envName: planCfg.envName, planId: plan.id, label: planCfg.item.name });
    console.log(`✓ ${planCfg.item.name}  →  ${plan.id}`);
  } catch (err) {
    console.error(`✗ ${planCfg.item.name} failed:`, err?.error?.description || err.message);
    process.exit(2);
  }
}

console.log("\n──────────────────────────────────────────────────────────────");
console.log("Paste these into Vercel → Project Settings → Environment Variables:\n");
for (const r of results) {
  console.log(`  ${r.envName}=${r.planId}`);
}
console.log("──────────────────────────────────────────────────────────────\n");
