import type { UserRecord } from "../types/auth";
import type { Env } from "../types/env";

const USER_KEY_PREFIX = "user:";
const EMAIL_KEY_PREFIX = "user_email:";

function userKey(id: string): string {
  return `${USER_KEY_PREFIX}${id}`;
}

function emailKey(email: string): string {
  return `${EMAIL_KEY_PREFIX}${email.toLowerCase()}`;
}

function requireUsersKv(env: Env): KVNamespace {
  if (!env.USERS) {
    throw new Error("USERS KV namespace is not configured");
  }
  return env.USERS;
}

export async function getUserByEmail(env: Env, email: string): Promise<UserRecord | null> {
  const kv = requireUsersKv(env);
  const id = await kv.get(emailKey(email));
  if (!id) return null;
  const raw = await kv.get(userKey(id), "json");
  if (!raw || typeof raw !== "object") return null;
  return raw as UserRecord;
}

export async function saveUser(env: Env, user: UserRecord): Promise<void> {
  const kv = requireUsersKv(env);
  await Promise.all([
    kv.put(userKey(user.id), JSON.stringify(user)),
    kv.put(emailKey(user.email), user.id)
  ]);
}
