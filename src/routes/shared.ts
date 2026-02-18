import { verifyJwt } from "../auth/jwt";
import { getUserById } from "../auth/userStore";
import { json } from "../middleware/json";
import type { Env } from "../types/env";
import type { UserRecord } from "../types/models";

export interface PublicUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phoneNumber: string;
  address?: string;
  plateNumber: string;
  hasPaymentMethod: boolean;
  hasPayoutAccount: boolean;
  createdAt: string;
}

export function badRequest(message: string): Response {
  return json({ error: message }, { status: 400 });
}

export function unauthorized(message = "Unauthorized"): Response {
  return json({ error: message }, { status: 401 });
}

export function conflict(message: string): Response {
  return json({ error: message }, { status: 409 });
}

export function notFound(message: string): Response {
  return json({ error: message }, { status: 404 });
}

export function requireSecret(env: Env): string {
  const secret = env.JWT_SECRET?.trim();
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return secret;
}

export function toPublicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    dateOfBirth: user.dateOfBirth,
    phoneNumber: user.phoneNumber,
    address: user.address,
    plateNumber: user.plateNumber,
    hasPaymentMethod: Boolean(user.paymentMethod),
    hasPayoutAccount: Boolean(user.payoutAccount),
    createdAt: user.createdAt
  };
}

export async function requireAuthenticatedUser(
  request: Request,
  env: Env
): Promise<{ user: UserRecord } | Response> {
  const auth = request.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return unauthorized("Missing bearer token");

  const payload = await verifyJwt(token, requireSecret(env));
  if (!payload) return unauthorized("Invalid token");

  const user = await getUserById(env, payload.sub);
  if (!user) return unauthorized("User does not exist");

  return { user };
}
