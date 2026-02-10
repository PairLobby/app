import { handlePreflight, withCors } from "./middleware/cors";
import { json } from "./middleware/json";
import { login, me, signup } from "./routes/auth";
import type { Env } from "./types/env";

function notFound(): Response {
  return json({ error: "Not found" }, { status: 404 });
}

function methodNotAllowed(): Response {
  return json({ error: "Method not allowed" }, { status: 405 });
}

async function router(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

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
