/**
 * /api/_lib/auth.js
 *
 * Shared helper for verifying that the caller of a POST endpoint is who
 * they claim to be. The underscore-prefixed `_lib` directory is NOT
 * deployed by Vercel as a serverless function — it's a shared module
 * importable from sibling files in /api/.
 *
 * Why this exists: every Razorpay POST endpoint receives a `userId` in
 * the request body and uses it to look up / mutate the corresponding
 * profile row. Without authentication, any caller could POST another
 * user's UUID and act as them — cancel their subscription, flip them to
 * is_active=true after replaying a captured signature, etc. (See
 * HANDOFF §15.1 for the full attack writeup.)
 *
 * The fix: every authenticated client request sends the user's Supabase
 * JWT in the Authorization header. This helper validates the token
 * against Supabase's auth API, returns the verified user, and the
 * endpoint asserts the verified user's id matches the claimed userId.
 *
 * Usage:
 *
 *   import { requireAuthedUser } from "./_lib/auth.js";
 *
 *   export default async function handler(req, res) {
 *     const { userId } = req.body || {};
 *     const auth = await requireAuthedUser(req, userId);
 *     if (!auth.ok) return res.status(auth.status).json({ error: auth.error });
 *     // ... safe to proceed; auth.user is the verified caller
 *   }
 *
 * Required env vars (read directly here so callers don't have to think
 * about it):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY        — for token verification (not service-role)
 */

import { createClient } from "@supabase/supabase-js";

/**
 * Verify the request's Authorization header against Supabase, then
 * compare the verified user's id to the userId the client claims in
 * the body.
 *
 * @param {object}  req           Vercel/Node request (has .headers, .body)
 * @param {string}  claimedUserId The userId from req.body
 * @returns {Promise<{ok:true, user:object} | {ok:false, status:number, error:string}>}
 */
export async function requireAuthedUser(req, claimedUserId) {
  if (!claimedUserId) {
    return { ok: false, status: 400, error: "userId is required." };
  }

  const url    = process.env.SUPABASE_URL;
  const anon   = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) {
    // Surface as 500 so misconfigured environments don't silently let
    // unauthenticated requests through.
    return { ok: false, status: 500, error: "Auth not configured (SUPABASE_ANON_KEY missing)." };
  }

  // Pull "Bearer <token>" out of the Authorization header. Tolerant of
  // mixed case ("authorization") which is what Vercel typically gives us.
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(String(header).trim());
  if (!m) {
    return { ok: false, status: 401, error: "Missing Authorization header." };
  }
  const token = m[1].trim();

  // Use the anon key + the user's JWT to ask Supabase "who is this token?".
  // Anon key is fine here — Supabase only verifies the JWT signature; it
  // doesn't grant any privileges based on the anon key for this call.
  const supa = createClient(url, anon, { auth: { persistSession: false } });
  let verifiedUser = null;
  try {
    const { data, error } = await supa.auth.getUser(token);
    if (error) {
      return { ok: false, status: 401, error: "Invalid or expired session — please sign in again." };
    }
    verifiedUser = data?.user;
  } catch (e) {
    console.warn("[auth] getUser threw:", e?.message);
    return { ok: false, status: 401, error: "Could not verify session." };
  }
  if (!verifiedUser?.id) {
    return { ok: false, status: 401, error: "Invalid session." };
  }

  // The crucial check: the verified caller must match the userId they're
  // trying to act on. This stops a logged-in user from POSTing someone
  // else's UUID and operating on that account.
  if (verifiedUser.id !== claimedUserId) {
    console.warn(`[auth] userId mismatch: token=${verifiedUser.id} claimed=${claimedUserId}`);
    return { ok: false, status: 403, error: "Authentication does not match the requested account." };
  }

  return { ok: true, user: verifiedUser };
}
