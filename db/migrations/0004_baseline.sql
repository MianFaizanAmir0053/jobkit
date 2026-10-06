-- Ledger: manual applications timed on the Baseline page before real use
-- (ledger spec, "The timing comparison"). These runs carry no job, which is
-- what keeps them out of the comparison's ratio; the manual arm's runs during
-- real use will be tied to their jobs.
create table {{schema}}.baseline_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  stopped_at timestamptz,
  route text check (route in ('email', 'form', 'message')),
  company text,
  role text,
  -- Either still running, or stopped with its route, company and role.
  check (
    (stopped_at is null and route is null and company is null and role is null)
    or (stopped_at is not null and route is not null and company is not null and role is not null)
  )
);
alter table {{schema}}.baseline_runs enable row level security;

-- One stopwatch at a time.
create unique index baseline_runs_one_running on {{schema}}.baseline_runs ((true))
  where stopped_at is null;
