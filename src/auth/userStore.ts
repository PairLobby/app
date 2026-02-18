import type { BookingRecord, ListingRecord, UserRecord } from "../types/models";
import type { Env, KvStore } from "../types/env";

const USER_KEY_PREFIX = "user:";
const EMAIL_KEY_PREFIX = "user_email:";
const LISTING_KEY_PREFIX = "listing:";
const BOOKING_KEY_PREFIX = "booking:";
const LISTING_IDS_KEY = "listing_ids";

function userKey(id: string): string {
  return `${USER_KEY_PREFIX}${id}`;
}

function emailKey(email: string): string {
  return `${EMAIL_KEY_PREFIX}${email.toLowerCase()}`;
}

function listingKey(id: string): string {
  return `${LISTING_KEY_PREFIX}${id}`;
}

function bookingKey(id: string): string {
  return `${BOOKING_KEY_PREFIX}${id}`;
}

function requireUsersKv(env: Env): KvStore {
  if (!env.USERS) {
    throw new Error("USERS KV namespace is not configured");
  }
  return env.USERS;
}

async function getJson<T>(kv: KvStore, key: string): Promise<T | null> {
  const raw = await kv.get(key, "json");
  if (!raw) return null;
  return raw as T;
}

export async function getUserByEmail(env: Env, email: string): Promise<UserRecord | null> {
  const kv = requireUsersKv(env);
  const id = await kv.get(emailKey(email));
  if (!id) return null;
  return getUserById(env, id);
}

export async function getUserById(env: Env, id: string): Promise<UserRecord | null> {
  const kv = requireUsersKv(env);
  const raw = await getJson<UserRecord>(kv, userKey(id));
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

export async function saveUser(env: Env, user: UserRecord): Promise<void> {
  const kv = requireUsersKv(env);
  await Promise.all([
    kv.put(userKey(user.id), JSON.stringify(user)),
    kv.put(emailKey(user.email), user.id)
  ]);
}

export async function getListingById(env: Env, id: string): Promise<ListingRecord | null> {
  const kv = requireUsersKv(env);
  const raw = await getJson<ListingRecord>(kv, listingKey(id));
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

export async function saveListing(env: Env, listing: ListingRecord): Promise<void> {
  const kv = requireUsersKv(env);
  await kv.put(listingKey(listing.id), JSON.stringify(listing));
}

export async function getAllListingIds(env: Env): Promise<string[]> {
  const kv = requireUsersKv(env);
  const ids = await getJson<string[]>(kv, LISTING_IDS_KEY);
  if (!Array.isArray(ids)) return [];
  return ids.filter((value): value is string => typeof value === "string");
}

async function saveAllListingIds(env: Env, ids: string[]): Promise<void> {
  const kv = requireUsersKv(env);
  await kv.put(LISTING_IDS_KEY, JSON.stringify(ids));
}

export async function addListingId(env: Env, listingId: string): Promise<void> {
  const ids = await getAllListingIds(env);
  if (ids.includes(listingId)) return;
  ids.unshift(listingId);
  await saveAllListingIds(env, ids);
}

export async function getListingsByIds(env: Env, ids: string[]): Promise<ListingRecord[]> {
  if (ids.length === 0) return [];
  const results = await Promise.all(ids.map((id) => getListingById(env, id)));
  return results.filter((item): item is ListingRecord => item !== null);
}

export async function getBookingById(env: Env, id: string): Promise<BookingRecord | null> {
  const kv = requireUsersKv(env);
  const raw = await getJson<BookingRecord>(kv, bookingKey(id));
  if (!raw || typeof raw !== "object") return null;
  return raw;
}

export async function saveBooking(env: Env, booking: BookingRecord): Promise<void> {
  const kv = requireUsersKv(env);
  await kv.put(bookingKey(booking.id), JSON.stringify(booking));
}

export async function getBookingsByIds(env: Env, ids: string[]): Promise<BookingRecord[]> {
  if (ids.length === 0) return [];
  const results = await Promise.all(ids.map((id) => getBookingById(env, id)));
  return results.filter((item): item is BookingRecord => item !== null);
}
