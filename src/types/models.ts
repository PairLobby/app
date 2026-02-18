export type DayOfWeek = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface ListingTimeSlot {
  day: DayOfWeek;
  start: string;
  end: string;
}

export interface PaymentMethod {
  brand: string;
  last4: string;
  addedAt: string;
}

export interface PayoutAccount {
  accountHolder: string;
  payoutReference: string;
  addedAt: string;
}

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  phoneNumber: string;
  address?: string;
  plateNumber: string;
  paymentMethod?: PaymentMethod;
  payoutAccount?: PayoutAccount;
  listingIds: string[];
  bookingIds: string[];
}

export interface ListingRecord {
  id: string;
  ownerId: string;
  title: string;
  address: string;
  pricePerHour: number;
  pictures: string[];
  description: string;
  timeSlots: ListingTimeSlot[];
  createdAt: string;
  updatedAt: string;
}

export type BookingStatus = "confirmed" | "cancelled";

export type PaymentStatus = "scheduled" | "penalty_withheld" | "cancelled_no_charge";

export interface BookingRecord {
  id: string;
  userId: string;
  listingId: string;
  startAt: string;
  durationHours: number;
  subtotal: number;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  paymentScheduledAt: string;
  penaltyAmount: number;
  createdAt: string;
  cancelledAt?: string;
}
