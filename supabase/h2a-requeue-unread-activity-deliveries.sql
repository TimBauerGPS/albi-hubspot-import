-- One-time repair: re-queue activity deliveries that failed only because Albi's create reply could not be read
-- (last_error_summary 'permanent:malformed_response', first live run on 2026-10-22).
--
-- Albi may already have created these activities. Re-queuing is safe: a re-queued delivery is reclaimed as a
-- retry, and every retry first searches the Albi contact's or organization's activities for the delivery's
-- source marker. A match is recorded as reconciled with no new write; only a delivery with no match is created.
--
-- Run once, after deploying the release that reads both Albi reply shapes. The next live sync picks them up.

begin;

update public.h2a_activity_deliveries
set next_attempt_at = pg_catalog.now(),
    updated_at = pg_catalog.now()
where state = 'failed'
  and next_attempt_at is null
  and albi_activity_id is null
  and last_error_summary = 'permanent:malformed_response';

commit;

-- Check: re-queued rows now have a retry time; nothing else changed.
select state, last_error_summary, count(*) as deliveries, count(next_attempt_at) as queued
from public.h2a_activity_deliveries
group by state, last_error_summary
order by state, last_error_summary;
