import { addListingId, getAllListingIds, getListingById, getListingsByIds, getUserById, saveListing, saveUser } from "../auth/userStore";
import { json, readJson } from "../middleware/json";
import type { Env } from "../types/env";
import type { DayOfWeek, ListingRecord, ListingTimeSlot, UserRecord } from "../types/models";
import { badRequest, notFound, requireAuthenticatedUser } from "./shared";

interface CreateListingRequest {
  title: string;
  address: string;
  pricePerHour: number;
  pictures: string[];
  description: string;
  timeSlots: ListingTimeSlot[];
}

interface PublicListing {
  id: string;
  ownerId: string;
  ownerName: string;
  title: string;
  address: string;
  pricePerHour: number;
  pictures: string[];
  description: string;
  timeSlots: ListingTimeSlot[];
  createdAt: string;
  updatedAt: string;
}

const DAYS: DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_SET = new Set<DayOfWeek>(DAYS);
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeText(value: string | undefined, maxLen: number): string {
  return (value ?? "").trim().slice(0, maxLen);
}

function validateSlots(slots: ListingTimeSlot[] | undefined): ListingTimeSlot[] {
  if (!Array.isArray(slots) || slots.length === 0) {
    throw new Error("At least one availability slot is required");
  }

  return slots.map((slot) => {
    const day = (slot?.day ?? "") as DayOfWeek;
    const start = (slot?.start ?? "").trim();
    const end = (slot?.end ?? "").trim();

    if (!DAY_SET.has(day)) {
      throw new Error("Each time slot must use a valid day (mon..sun)");
    }

    if (!TIME_REGEX.test(start) || !TIME_REGEX.test(end)) {
      throw new Error("Each time slot must use 24-hour HH:MM format");
    }

    if (start >= end) {
      throw new Error("Each time slot end time must be after start time");
    }

    return { day, start, end };
  });
}

function toPublicListing(listing: ListingRecord, ownerName: string): PublicListing {
  return {
    id: listing.id,
    ownerId: listing.ownerId,
    ownerName,
    title: listing.title,
    address: listing.address,
    pricePerHour: listing.pricePerHour,
    pictures: listing.pictures,
    description: listing.description,
    timeSlots: listing.timeSlots,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt
  };
}

async function ownerNameFor(env: Env, ownerId: string): Promise<string> {
  const owner = await getUserById(env, ownerId);
  if (!owner) return "Unknown host";
  return `${owner.firstName} ${owner.lastName}`.trim();
}

function applyListingValidation(body: CreateListingRequest): Omit<ListingRecord, "id" | "ownerId" | "createdAt" | "updatedAt"> {
  const title = normalizeText(body.title, 100);
  const address = normalizeText(body.address, 160);
  const description = normalizeText(body.description, 800);
  const pricePerHour = Number(body.pricePerHour);
  const pictures = Array.isArray(body.pictures)
    ? body.pictures
        .map((picture) => (typeof picture === "string" ? picture.trim() : ""))
        .filter((picture) => picture.length > 0)
        .slice(0, 8)
    : [];
  const timeSlots = validateSlots(body.timeSlots);

  if (!title) throw new Error("Listing title is required");
  if (!address) throw new Error("Listing address is required");
  if (!description) throw new Error("Listing description is required");
  if (!Number.isFinite(pricePerHour) || pricePerHour <= 0) {
    throw new Error("Listing price/hour must be a positive number");
  }
  if (pictures.length === 0) throw new Error("At least one listing picture URL is required");

  return {
    title,
    address,
    description,
    pricePerHour: Math.round(pricePerHour * 100) / 100,
    pictures,
    timeSlots
  };
}

export async function createListing(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuthenticatedUser(request, env);
  if (authResult instanceof Response) return authResult;

  const user = authResult.user;
  if (!user.payoutAccount) {
    return badRequest("Add account info to receive payouts before listing a spot");
  }

  let body: CreateListingRequest;
  try {
    body = await readJson<CreateListingRequest>(request);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  let normalized: Omit<ListingRecord, "id" | "ownerId" | "createdAt" | "updatedAt">;
  try {
    normalized = applyListingValidation(body);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const now = new Date().toISOString();
  const listing: ListingRecord = {
    id: crypto.randomUUID(),
    ownerId: user.id,
    ...normalized,
    createdAt: now,
    updatedAt: now
  };

  const updatedUser: UserRecord = {
    ...user,
    listingIds: [listing.id, ...user.listingIds.filter((id) => id !== listing.id)]
  };

  await Promise.all([saveListing(env, listing), addListingId(env, listing.id), saveUser(env, updatedUser)]);

  const ownerName = `${user.firstName} ${user.lastName}`.trim();
  return json({ listing: toPublicListing(listing, ownerName) }, { status: 201 });
}

export async function listListings(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get("search")?.trim().toLowerCase() ?? "";

  const ids = await getAllListingIds(env);
  const listings = await getListingsByIds(env, ids);

  const filtered = query
    ? listings.filter((listing) => {
        const text = `${listing.title} ${listing.address} ${listing.description}`.toLowerCase();
        return text.includes(query);
      })
    : listings;

  const ownerIds = [...new Set(filtered.map((listing) => listing.ownerId))];
  const owners = await Promise.all(
    ownerIds.map(async (ownerId) => {
      const name = await ownerNameFor(env, ownerId);
      return [ownerId, name] as const;
    })
  );

  const ownerMap = new Map<string, string>(owners);

  const payload = filtered
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((listing) => toPublicListing(listing, ownerMap.get(listing.ownerId) ?? "Unknown host"));

  return json({ listings: payload });
}

export async function getListing(env: Env, listingId: string): Promise<Response> {
  const listing = await getListingById(env, listingId);
  if (!listing) return notFound("Listing not found");

  const ownerName = await ownerNameFor(env, listing.ownerId);
  return json({ listing: toPublicListing(listing, ownerName) });
}
