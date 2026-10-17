-- How a job came in (intake spec, "Inputs" and "Upload path"): from the New
-- job page or the share target, and the links its post gave, in the pasted
-- text or the share's url field, which are kept as a reference and never
-- fetched. Every upload attempt is logged with its outcome, for the Stats
-- page's upload success (ledger spec, "Records"): a job's first attempt
-- starts as it is created, and each request for fresh upload URLs ends the
-- attempt before it as failed and starts another. One the job leaves
-- uploading by another way (the upload timeout, Skip) stays open, and the
-- Stats page counts it failed.

alter table {{schema}}.jobs add column input_kind text check (input_kind in ('page', 'share'));
alter table {{schema}}.jobs add column post_links text[] not null default '{}';

create table {{schema}}.upload_attempts (
  id uuid primary key default gen_random_uuid(),
  -- An attempt says nothing once its job is gone.
  job_id uuid not null references {{schema}}.jobs (id) on delete cascade,
  started_at timestamptz not null,
  files smallint not null check (files >= 1),
  bytes integer not null check (bytes >= 1),
  outcome text check (outcome in ('ok', 'failed')),
  ended_at timestamptz,
  check ((outcome is null) = (ended_at is null))
);
alter table {{schema}}.upload_attempts enable row level security;
create unique index upload_attempts_one_open on {{schema}}.upload_attempts (job_id)
  where outcome is null;
