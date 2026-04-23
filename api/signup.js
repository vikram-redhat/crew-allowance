/**
 * /api/signup.js
 *
 * Server-side signup with atomic rollback.
 *
 * Why this exists: doing auth.signUp + profiles.insert from the browser leaves
 * an orphaned auth.users row if the profile insert fails (e.g. duplicate
 * employee ID). The user then can't retry because their email is "taken".
 *
 * This endpoint does both with the service role key, and if the profile insert
 * fails, it deletes the just-created auth user so the email/password are freed
 * for a clean retry.
 *
 * Required env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Supabase not configured." });

  const { name, email, password, emp_id, rank, home_base } = req.body || {};

  // ─── Validation ─────────────────────────────────────────────────────────
  if (!name || !email || !password || !emp_id || !rank || !home_base) {
    return res.status(400).json({ error: "All fields are required." });
  }
  if (!/\S+@\S+\.\S+/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const empIdTrim = String(emp_id).trim();
  const homeBaseClean = String(home_base).toUpperCase().slice(0, 3);

  const admin = createClient(url, key, { auth: { persistSession: false } });

  // ─── Pre-check: emp_id already taken? ───────────────────────────────────
  // Doing this before auth.signUp avoids creating + immediately deleting an
  // auth user in the common "duplicate ID" case.
  const { data: existingByEmpId } = await admin
    .from("profiles")
    .select("id")
    .eq("emp_id", empIdTrim)
    .maybeSingle();

  if (existingByEmpId) {
    return res.status(409).json({ error: "duplicate_emp_id" });
  }

  // ─── Create auth user ───────────────────────────────────────────────────
  // Using admin.createUser instead of auth.signUp because the latter sends
  // a confirmation email and returns a "fake" user when the email is
  // already taken (enumeration protection). admin.createUser returns a
  // clear error on duplicate email.
  //
  // email_confirm:true skips the email verification step. Trust signal is
  // (a) successful payment for paid users, or (b) admin approval for comp
  // users (is_active stays false until an admin activates them).
  const { data: created, error: signupErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (signupErr) {
    const msg = (signupErr.message || "").toLowerCase();
    if (msg.includes("already") || msg.includes("registered") || msg.includes("exists")) {
      return res.status(409).json({ error: "duplicate_email" });
    }
    return res.status(500).json({ error: signupErr.message || "Signup failed." });
  }

  const userId = created?.user?.id;
  if (!userId) {
    return res.status(500).json({ error: "Auth user could not be created." });
  }

  // ─── Insert profile — rollback auth user on failure ─────────────────────
  const { error: profileErr } = await admin.from("profiles").insert({
    id:        userId,
    name,
    email,
    emp_id:    empIdTrim,
    rank,
    home_base: homeBaseClean,
    is_admin:  false,
    is_active: false,
  });

  if (profileErr) {
    // Roll back the auth user so the email/password are freed for retry.
    try { await admin.auth.admin.deleteUser(userId); } catch { /* best-effort */ }

    const msg = (profileErr.message || "").toLowerCase();
    if (msg.includes("emp_id") || msg.includes("profiles_emp_id_unique")) {
      return res.status(409).json({ error: "duplicate_emp_id" });
    }
    return res.status(500).json({ error: profileErr.message || "Could not create profile." });
  }

  return res.status(200).json({
    user: { id: userId, name, email, emp_id: empIdTrim, rank, home_base: homeBaseClean },
  });
}
