# Backend Requirements Status

Source: `20260215 - Functional Requirements.pdf` (MVP execution plan + error/warning handling)

## All Required (backend-relevant)

### Authentication and account
- Account sign in with:
  - Email
  - Password
- Account creation with:
  - Name / Last name
  - Date of birth
  - Email
  - Phone number
  - Address (optional)
  - Car plate number
- On successful sign in / sign up, data must support redirect to Home flow (frontend handles redirect).

### Profile and account data
- Profile data must be retrievable and editable.
- Add payment method support for booking charges.
- Add payout account info support for hosts listing spots.

### Listings
- Create listing with:
  - Title
  - Address
  - Price / hour
  - Pictures
  - Description
  - Time of day available (slots)
- Listing discovery endpoint(s) for Find Parking.
- Listing detail endpoint for description page.

### Bookings
- Create booking for a listing.
- Payment should be handled at booking start time (e.g., booked for 2:30 PM, payment goes through then).
- Return bookings history so frontend can show:
  - Current bookings
  - Previous bookings
  - Descending order by start/booking time
- Cancellation behavior:
  - Up to 2 hours before start: no penalty
  - Less than 2 hours before start: 10% penalty withheld right away
- Book-again flow support from previous bookings.

### Error / warning blocking rules (Epic 2)
- Block listing creation if user has no payout account info.
- Block booking if user has no payment info.
- Block booking if user has no plate number.

## Implemented

### Authentication and account
- `POST /auth/signup` implemented with required fields (including DOB, phone, optional address, plate).
- `POST /auth/login` implemented.
- `GET /auth/me` implemented.
- JWT auth + user persistence in KV implemented.

### Profile and account data
- `PATCH /profile` implemented for editable profile fields.
- `POST /profile/payment-method` implemented.
- `POST /profile/payout-account` implemented.

### Listings
- `POST /listings` implemented with validation for title/address/price/pictures/description/time slots.
- `GET /listings` implemented with text search (`?search=`).
- `GET /listings/:id` implemented.

### Bookings
- `POST /bookings` implemented.
- `GET /bookings` implemented (frontend can separate current/previous).
- `POST /bookings/:id/cancel` implemented.
- Descending sort by start time (then created time) implemented in backend response.
- Booking references listing id, enabling "book again" behavior.

### Blocking rules (Epic 2)
- Listing blocked without payout account: implemented.
- Booking blocked without payment method: implemented.
- Booking blocked without plate number: implemented.

### Cancellation policy
- 2-hour rule + 10% penalty calculation: implemented.
- Cancellation status and penalty amount persisted on booking.

## Not Implemented Yet / Partial

- Real payment processing/capture at booking start time is not integrated.
  - Current behavior: booking stores `paymentStatus` as scheduled and `paymentScheduledAt` timestamp.
- Real-time financial withholding for 10% cancellation penalty is not integrated with a payment provider.
  - Current behavior: penalty is calculated and stored as booking metadata.
- Dedicated ratings/reviews and chat backend features are not implemented.
  - Explicitly marked out-of-scope in the source requirements.
- Geolocation/map-aware listing proximity endpoints are not implemented.
  - Map/navigation features are marked phase 2 or out-of-scope.

## Explicitly Out of Scope (from source)
- Rating
- Chat
- Map (interactive)
- Connection with towing companies and other partners
- Embedded referral link (e.g., in QR code)
- QR code
- Log in 2-layer authentication
- AI scheduler to optimize matching schedules
