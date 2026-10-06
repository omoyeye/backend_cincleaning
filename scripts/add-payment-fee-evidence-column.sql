-- Run once on MySQL if `payment_fee_evidence` is missing (matches server/schema.ts).
ALTER TABLE bookings
  ADD COLUMN payment_fee_evidence JSON NULL
  COMMENT 'Customer deposit/cancellation fee payment proof (data URLs)'
  AFTER short_notice_cancel_fee_consented_at;
