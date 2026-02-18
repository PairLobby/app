import type { Env } from "../types/env";

export function buildCorsHeaders(env: Env): HeadersInit {
  return {
    "Access-Control-Allow-Origin": env.CORS_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400"
  };
}

export function withCors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(buildCorsHeaders(env))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function handlePreflight(request: Request, env: Env): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(env)
  });
}
