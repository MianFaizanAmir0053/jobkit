-- After one-click send's first review (decisions A20): a send whose outcome
-- jobkit cannot tell, because Gmail may have taken it, is kept apart from
-- one that failed, as `unknown`. One send per job and role can be in flight
-- (scheduled or sending): an email Gmail took is recorded as sent though the
-- owner pressed again meanwhile, and the kit then holds as sent. The Gmail
-- connection records when Google last refused it, so the pages can say to
-- connect again.

alter table {{schema}}.kit_sends drop constraint kit_sends_status_check;
alter table {{schema}}.kit_sends add constraint kit_sends_status_check
  check (status in ('scheduled', 'cancelled', 'sending', 'sent', 'failed', 'unknown'));
drop index {{schema}}.kit_sends_one_live;
create unique index kit_sends_one_in_flight on {{schema}}.kit_sends (job_id, role_id)
  where status in ('scheduled', 'sending');

alter table {{schema}}.gmail_connection add column refused_at timestamptz;
