import type { UserRecord } from "../types/auth";

const usersByEmail = new Map<string, UserRecord>();

export function getUserByEmail(email: string): UserRecord | undefined {
  return usersByEmail.get(email.toLowerCase());
}

export function saveUser(user: UserRecord): void {
  usersByEmail.set(user.email.toLowerCase(), user);
}
