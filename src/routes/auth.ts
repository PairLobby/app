import { createJwt, verifyJwt } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { getUserByEmail, saveUser } from "../auth/userStore";
import { json, readJson } from "../middleware/json";
import type { LoginRequest, SignupRequest } from "../types/auth";
import type { Env } from "../types/env";

function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

function requireSecret(env: Env): string {
  const secret = env.JWT_SECRET?.trim();
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return secret;
}

function sanitizeUser(input: { id: string; email: string; name: string; createdAt: string }) {
  return {
    id: input.id,
    email: input.email,
    name: input.name,
    createdAt: input.createdAt
  };
}

export async function signup(request: Request, env: Env): Promise<Response> {
  let body: SignupRequest;
  try {
    body = await readJson<SignupRequest>(request);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password?.trim();
  const name = (body.name?.trim() || "user").slice(0, 64);

  if (!email || !email.includes("@")) return badRequest("A valid email is required");
  if (!password || password.length < 8) return badRequest("Password must be at least 8 characters");
  if (await getUserByEmail(env, email)) return json({ error: "Email already registered" }, { status: 409 });

  const now = new Date().toISOString();
  const user = {
    id: crypto.randomUUID(),
    email,
    name,
    passwordHash: await hashPassword(password),
    createdAt: now
  };

  await saveUser(env, user);

  const secret = requireSecret(env);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 7;
  const token = await createJwt({ sub: user.id, email: user.email, name: user.name, iat, exp }, secret);

  return json({ token, user: sanitizeUser(user) }, { status: 201 });
}

export async function login(request: Request, env: Env): Promise<Response> {
  let body: LoginRequest;
  try {
    body = await readJson<LoginRequest>(request);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const email = body.email?.trim().toLowerCase();
  const password = body.password?.trim();

  if (!email || !password) return badRequest("Email and password are required");

  const user = await getUserByEmail(env, email);
  if (!user) return json({ error: "Invalid credentials" }, { status: 401 });

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return json({ error: "Invalid credentials" }, { status: 401 });

  const secret = requireSecret(env);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 7;
  const token = await createJwt({ sub: user.id, email: user.email, name: user.name, iat, exp }, secret);

  return json({ token, user: sanitizeUser(user) });
}

export async function me(request: Request, env: Env): Promise<Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ error: "Missing bearer token" }, { status: 401 });

  const payload = await verifyJwt(token, requireSecret(env));
  if (!payload) return json({ error: "Invalid token" }, { status: 401 });

  return json({
    user: {
      id: payload.sub,
      email: payload.email,
      name: payload.name
    }
  });
}
