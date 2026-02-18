import { handlePreflight, withCors } from "./middleware/cors";
import { json } from "./middleware/json";
import { login, me, signup } from "./routes/auth";
import { cancelBooking, createBooking, listBookings } from "./routes/bookings";
import { createListing, getListing, listListings } from "./routes/listings";
import { addPaymentMethod, addPayoutAccount, updateProfile } from "./routes/profile";
import type { Env } from "./types/env";

function notFound(): Response {
  return json({ error: "Not found" }, { status: 404 });
}

function methodNotAllowed(): Response {
  return json({ error: "Method not allowed" }, { status: 405 });
}

async function router(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/health") {
    if (request.method !== "GET") return methodNotAllowed();
    return json({ ok: true, service: "parking-backend", time: new Date().toISOString() });
  }

  if (url.pathname === "/auth/signup") {
    if (request.method !== "POST") return methodNotAllowed();
    return signup(request, env);
  }

  if (url.pathname === "/auth/login") {
    if (request.method !== "POST") return methodNotAllowed();
    return login(request, env);
  }

  if (url.pathname === "/auth/me") {
    if (request.method !== "GET") return methodNotAllowed();
    return me(request, env);
  }

  if (url.pathname === "/profile") {
    if (request.method !== "PATCH") return methodNotAllowed();
    return updateProfile(request, env);
  }

  if (url.pathname === "/profile/payment-method") {
    if (request.method !== "POST") return methodNotAllowed();
    return addPaymentMethod(request, env);
  }

  if (url.pathname === "/profile/payout-account") {
    if (request.method !== "POST") return methodNotAllowed();
    return addPayoutAccount(request, env);
  }

  if (url.pathname === "/listings") {
    if (request.method === "GET") return listListings(request, env);
    if (request.method === "POST") return createListing(request, env);
    return methodNotAllowed();
  }

  if (segments.length === 2 && segments[0] === "listings") {
    if (request.method !== "GET") return methodNotAllowed();
    return getListing(env, segments[1]);
  }

  if (url.pathname === "/bookings") {
    if (request.method === "GET") return listBookings(request, env);
    if (request.method === "POST") return createBooking(request, env);
    return methodNotAllowed();
  }

  if (segments.length === 3 && segments[0] === "bookings" && segments[2] === "cancel") {
    if (request.method !== "POST") return methodNotAllowed();
    return cancelBooking(env, request, segments[1]);
  }

  return notFound();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const preflight = handlePreflight(request, env);
    if (preflight) return preflight;

    try {
      const response = await router(request, env);
      return withCors(response, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return withCors(json({ error: message }, { status: 500 }), env);
    }
  }
};
