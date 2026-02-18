import { getBookingById, getBookingsByIds, getListingById, getListingsByIds, saveBooking, saveUser } from "../auth/userStore";
import { json, readJson } from "../middleware/json";
import type { Env } from "../types/env";
import type { BookingRecord, ListingRecord, UserRecord } from "../types/models";
import { badRequest, conflict, notFound, requireAuthenticatedUser } from "./shared";

interface CreateBookingRequest {
  listingId: string;
  startAt: string;
  durationHours: number;
}

interface PublicListingSummary {
  id: string;
  title: string;
  address: string;
  pricePerHour: number;
  pictures: string[];
}

interface PublicBooking {
  id: string;
  listingId: string;
  startAt: string;
  durationHours: number;
  subtotal: number;
  status: BookingRecord["status"];
  paymentStatus: BookingRecord["paymentStatus"];
  paymentScheduledAt: string;
  penaltyAmount: number;
  createdAt: string;
  cancelledAt?: string;
  listing?: PublicListingSummary;
}

function roundCents(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function toListingSummary(listing: ListingRecord): PublicListingSummary {
  return {
    id: listing.id,
    title: listing.title,
    address: listing.address,
    pricePerHour: listing.pricePerHour,
    pictures: listing.pictures
  };
}

function toPublicBooking(booking: BookingRecord, listing?: ListingRecord): PublicBooking {
  return {
    id: booking.id,
    listingId: booking.listingId,
    startAt: booking.startAt,
    durationHours: booking.durationHours,
    subtotal: booking.subtotal,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    paymentScheduledAt: booking.paymentScheduledAt,
    penaltyAmount: booking.penaltyAmount,
    createdAt: booking.createdAt,
    cancelledAt: booking.cancelledAt,
    listing: listing ? toListingSummary(listing) : undefined
  };
}

function sortBookings(bookings: BookingRecord[]): BookingRecord[] {
  return [...bookings].sort((a, b) => {
    const byStart = b.startAt.localeCompare(a.startAt);
    if (byStart !== 0) return byStart;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

export async function listBookings(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuthenticatedUser(request, env);
  if (authResult instanceof Response) return authResult;

  const user = authResult.user;
  const bookings = sortBookings(await getBookingsByIds(env, user.bookingIds));

  const listingIds = [...new Set(bookings.map((booking) => booking.listingId))];
  const listings = await getListingsByIds(env, listingIds);
  const listingMap = new Map<string, ListingRecord>(listings.map((listing) => [listing.id, listing]));

  return json({
    bookings: bookings.map((booking) => toPublicBooking(booking, listingMap.get(booking.listingId)))
  });
}

export async function createBooking(request: Request, env: Env): Promise<Response> {
  const authResult = await requireAuthenticatedUser(request, env);
  if (authResult instanceof Response) return authResult;

  const user = authResult.user;

  if (!user.paymentMethod) {
    return badRequest("Add a payment method before booking a spot");
  }
  if (!user.plateNumber.trim()) {
    return badRequest("Add a car plate number before booking a spot");
  }

  let body: CreateBookingRequest;
  try {
    body = await readJson<CreateBookingRequest>(request);
  } catch (err) {
    return badRequest((err as Error).message);
  }

  const listingId = body.listingId?.trim();
  if (!listingId) return badRequest("listingId is required");

  const listing = await getListingById(env, listingId);
  if (!listing) return notFound("Listing not found");

  const durationHours = Number(body.durationHours);
  if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > 24) {
    return badRequest("durationHours must be a positive number no higher than 24");
  }

  const startAt = body.startAt?.trim();
  if (!startAt) return badRequest("startAt is required");

  const parsedStartAt = new Date(startAt);
  if (Number.isNaN(parsedStartAt.getTime())) {
    return badRequest("startAt must be a valid date-time");
  }

  const subtotal = roundCents(durationHours * listing.pricePerHour);
  const now = new Date().toISOString();

  const booking: BookingRecord = {
    id: crypto.randomUUID(),
    userId: user.id,
    listingId: listing.id,
    startAt: parsedStartAt.toISOString(),
    durationHours: roundCents(durationHours),
    subtotal,
    status: "confirmed",
    paymentStatus: "scheduled",
    paymentScheduledAt: parsedStartAt.toISOString(),
    penaltyAmount: 0,
    createdAt: now
  };

  const updatedUser: UserRecord = {
    ...user,
    bookingIds: [booking.id, ...user.bookingIds.filter((id) => id !== booking.id)]
  };

  await Promise.all([saveBooking(env, booking), saveUser(env, updatedUser)]);

  return json(
    {
      booking: toPublicBooking(booking, listing),
      payment: {
        status: "scheduled",
        message: `Payment is scheduled for ${booking.paymentScheduledAt}`
      }
    },
    { status: 201 }
  );
}

export async function cancelBooking(env: Env, request: Request, bookingId: string): Promise<Response> {
  const authResult = await requireAuthenticatedUser(request, env);
  if (authResult instanceof Response) return authResult;

  const user = authResult.user;
  const booking = await getBookingById(env, bookingId);
  if (!booking || booking.userId !== user.id) return notFound("Booking not found");

  if (booking.status === "cancelled") {
    return conflict("Booking already cancelled");
  }

  const now = new Date();
  const start = new Date(booking.startAt);
  const hoursUntilStart = (start.getTime() - now.getTime()) / (1000 * 60 * 60);
  const penaltyAmount = hoursUntilStart < 2 ? roundCents(booking.subtotal * 0.1) : 0;

  const updatedBooking: BookingRecord = {
    ...booking,
    status: "cancelled",
    cancelledAt: now.toISOString(),
    penaltyAmount,
    paymentStatus: penaltyAmount > 0 ? "penalty_withheld" : "cancelled_no_charge"
  };

  await saveBooking(env, updatedBooking);

  return json({
    booking: toPublicBooking(updatedBooking),
    cancellationPolicy: {
      noPenaltyWindowHours: 2,
      penaltyRate: 0.1,
      penaltyApplied: penaltyAmount > 0
    }
  });
}
