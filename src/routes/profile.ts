import { saveUser } from "../auth/userStore";
import { json, readJson } from "../middleware/json";
import type { Env } from "../types/env";
import type { UserRecord } from "../types/models";
import { badRequest, requireAuthenticatedUser, toPublicUser } from "./shared";

interface UpdateProfileRequest {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  phoneNumber?: string;
  address?: string;
  plateNumber?: string;
}

interface AddPaymentMethodRequest {
  brand: string;
  last4: string;
}

interface AddPayoutAccountRequest {
  accountHolder: string;
  payoutReference: string;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

function applyProfileUpdate(user: UserRecord, body: UpdateProfileRequest): UserRecord {
  const next: UserRecord = {
    ...user,
    firstName: user.firstName,
    lastName: user.lastName,
    dateOfBirth: user.dateOfBirth,
    phoneNumber: user.phoneNumber,
    address: user.address,
    plateNumber: user.plateNumber
  };

  if (Object.hasOwn(body, "firstName")) {
    const firstName = (body.firstName ?? "").trim().slice(0, 64);
    if (!firstName) throw new Error("First name cannot be empty");
    next.firstName = firstName;
  }

  if (Object.hasOwn(body, "lastName")) {
    const lastName = (body.lastName ?? "").trim().slice(0, 64);
    if (!lastName) throw new Error("Last name cannot be empty");
    next.lastName = lastName;
  }

  if (Object.hasOwn(body, "dateOfBirth")) {
    const dateOfBirth = (body.dateOfBirth ?? "").trim();
    if (!dateOfBirth || !isValidDate(dateOfBirth)) {
      throw new Error("Date of birth must use YYYY-MM-DD");
    }
    next.dateOfBirth = dateOfBirth;
  }

  if (Object.hasOwn(body, "phoneNumber")) {
    const phoneNumber = (body.phoneNumber ?? "").trim().slice(0, 32);
    if (!phoneNumber) throw new Error("Phone number cannot be empty");
    next.phoneNumber = phoneNumber;
  }

  if (Object.hasOwn(body, "address")) {
    const address = (body.address ?? "").trim().slice(0, 160);
    next.address = address || undefined;
  }

  if (Object.hasOwn(body, "plateNumber")) {
    next.plateNumber = (body.plateNumber ?? "").trim().toUpperCase().slice(0, 20);
  }

  return next;
}

export async function updateProfile(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuthenticatedUser(request, env);
  if (authResult instanceof Response) return authResult;

  let body: UpdateProfileRequest;
  try {
    body = await readJson<UpdateProfileRequest>(request);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  let updatedUser: UserRecord;
  try {
    updatedUser = applyProfileUpdate(authResult.user, body);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  await saveUser(env, updatedUser);
  return json({ user: toPublicUser(updatedUser) });
}

export async function addPaymentMethod(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuthenticatedUser(request, env);
  if (authResult instanceof Response) return authResult;

  let body: AddPaymentMethodRequest;
  try {
    body = await readJson<AddPaymentMethodRequest>(request);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const brand = body.brand?.trim().slice(0, 32);
  const last4 = body.last4?.trim();
  if (!brand) return badRequest("Payment brand is required");
  if (!last4 || !/^\d{4}$/.test(last4)) {
    return badRequest("Payment card last4 must be exactly 4 digits");
  }

  const updatedUser: UserRecord = {
    ...authResult.user,
    paymentMethod: {
      brand,
      last4,
      addedAt: new Date().toISOString()
    }
  };

  await saveUser(env, updatedUser);
  return json({
    user: toPublicUser(updatedUser),
    paymentMethod: updatedUser.paymentMethod
  });
}

export async function addPayoutAccount(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuthenticatedUser(request, env);
  if (authResult instanceof Response) return authResult;

  let body: AddPayoutAccountRequest;
  try {
    body = await readJson<AddPayoutAccountRequest>(request);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const accountHolder = body.accountHolder?.trim().slice(0, 80);
  const payoutReference = body.payoutReference?.trim().slice(0, 120);
  if (!accountHolder) return badRequest("Account holder is required");
  if (!payoutReference) return badRequest("Payout reference is required");

  const updatedUser: UserRecord = {
    ...authResult.user,
    payoutAccount: {
      accountHolder,
      payoutReference,
      addedAt: new Date().toISOString()
    }
  };

  await saveUser(env, updatedUser);
  return json({
    user: toPublicUser(updatedUser),
    payoutAccount: updatedUser.payoutAccount
  });
}
