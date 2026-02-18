import { createJwt } from "../auth/jwt";
import { hashPassword, verifyPassword } from "../auth/password";
import { getUserByEmail, saveUser } from "../auth/userStore";
import { json, readJson } from "../middleware/json";
import type { JwtPayload, LoginRequest, SignupRequest } from "../types/auth";
import type { Env } from "../types/env";
import type { UserRecord } from "../types/models";
import { badRequest, conflict, requireAuthenticatedUser, requireSecret, toPublicUser } from "./shared";

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

function normalizeName(value: string | undefined): string {
  return (value ?? "").trim().slice(0, 64);
}

function normalizePhone(value: string | undefined): string {
  return (value ?? "").trim().slice(0, 32);
}

function normalizePlate(value: string | undefined): string {
  return (value ?? "").trim().toUpperCase().slice(0, 20);
}

async function createToken(user: UserRecord, env: Env): Promise<string> {
  const secret = requireSecret(env);
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 60 * 60 * 24 * 7;
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    name: `${user.firstName} ${user.lastName}`.trim(),
    iat,
    exp
  };

  return createJwt(payload, secret);
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
  const firstName = normalizeName(body.firstName);
  const lastName = normalizeName(body.lastName);
  const dateOfBirth = body.dateOfBirth?.trim();
  const phoneNumber = normalizePhone(body.phoneNumber);
  const address = body.address?.trim().slice(0, 160) || undefined;
  const plateNumber = normalizePlate(body.plateNumber);

  if (!email || !email.includes("@")) return badRequest("A valid email is required");
  if (!password || password.length < 8) return badRequest("Password must be at least 8 characters");
  if (!firstName) return badRequest("First name is required");
  if (!lastName) return badRequest("Last name is required");
  if (!dateOfBirth || !isValidDate(dateOfBirth)) return badRequest("A valid date of birth is required (YYYY-MM-DD)");
  if (!phoneNumber) return badRequest("Phone number is required");
  if (!plateNumber) return badRequest("Car plate number is required");

  if (await getUserByEmail(env, email)) return conflict("Email already registered");

  const now = new Date().toISOString();
  const user: UserRecord = {
    id: crypto.randomUUID(),
    email,
    firstName,
    lastName,
    dateOfBirth,
    phoneNumber,
    address,
    plateNumber,
    passwordHash: await hashPassword(password),
    createdAt: now,
    listingIds: [],
    bookingIds: []
  };

  await saveUser(env, user);

  const token = await createToken(user, env);
  return json({ token, user: toPublicUser(user) }, { status: 201 });
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

  const token = await createToken(user, env);
  return json({ token, user: toPublicUser(user) });
}

export async function me(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuthenticatedUser(request, env);
  if (authResult instanceof Response) return authResult;

  return json({ user: toPublicUser(authResult.user) });
}
