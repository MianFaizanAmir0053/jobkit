-- Platform: jobs, their state changes, stage runs and leases (platform spec
-- B9). Only the runner and the owner's actions move a job, along the spec's
-- table; every move is recorded with its time.

create table {{schema}}.jobs (
  id uuid primary key default gen_random_uuid(),
  state text not null check (state in (
    'manual_run', 'uploading', 'upload_failed', 'queued', 'extracting', 'needs_role_pick',
    'checking', 'needs_eligibility_decision', 'needs_kit_type', 'drafting', 'judging',
    'kit_ready', 'stopped', 'failed', 'closed'
  )),
  -- The stage due next while the job runs; a failed job keeps the stage it failed at.
  pending_stage text check (pending_stage in (
    'extract', 'extract_questions', 'eligibility', 'draft', 'draft_answers', 'judge'
  )),
  state_changed_at timestamptz not null,
  -- The stage that failed and why, in words the job page shows beside Retry and Skip.
  failed_stage text check (failed_stage in (
    'extract', 'extract_questions', 'eligibility', 'draft', 'draft_answers',
    'address_read', 'address_checks', 'judge'
  )),
  failure text,
  -- Retry starts a new round, in which a stage's unfinished starts count afresh.
  retry_round integer not null default 0,
  -- The server's time when the job was created, and how long the phone held
  -- it before that: the job starts at their difference (intake spec, "Clock").
  received_at timestamptz not null,
  client_elapsed_ms integer not null default 0 check (client_elapsed_ms >= 0),
  -- The live lease: the invocation running the job, until its claim lapses.
  lease_id uuid,
  lease_expires_at timestamptz,
  check ((lease_id is null) = (lease_expires_at is null))
);
alter table {{schema}}.jobs enable row level security;

-- The upload timeout finds jobs still uploading.
create index jobs_uploading on {{schema}}.jobs (state_changed_at) where state = 'uploading';

create table {{schema}}.job_state_changes (
  id bigint generated always as identity primary key,
  job_id uuid not null references {{schema}}.jobs (id),
  -- None for the state a job is created in.
  from_state text check (from_state in (
    'manual_run', 'uploading', 'upload_failed', 'queued', 'extracting', 'needs_role_pick',
    'checking', 'needs_eligibility_decision', 'needs_kit_type', 'drafting', 'judging',
    'kit_ready', 'stopped', 'failed', 'closed'
  )),
  to_state text not null check (to_state in (
    'manual_run', 'uploading', 'upload_failed', 'queued', 'extracting', 'needs_role_pick',
    'checking', 'needs_eligibility_decision', 'needs_kit_type', 'drafting', 'judging',
    'kit_ready', 'stopped', 'failed', 'closed'
  )),
  at timestamptz not null
);
alter table {{schema}}.job_state_changes enable row level security;

create index job_state_changes_job on {{schema}}.job_state_changes (job_id, id);

-- Every claim of a job's lease, for the times' unpolled gaps.
create table {{schema}}.job_leases (
  id uuid primary key,
  job_id uuid not null references {{schema}}.jobs (id),
  claimed_at timestamptz not null,
  expires_at timestamptz not null,
  released_at timestamptz
);
alter table {{schema}}.job_leases enable row level security;

create index job_leases_job on {{schema}}.job_leases (job_id, claimed_at);

-- One row per start of a stage, and one per reuse of an earlier output; a
-- stage's latest `ok` or `reused` row holds its current output.
create table {{schema}}.job_stage_runs (
  id bigint generated always as identity primary key,
  job_id uuid not null references {{schema}}.jobs (id),
  lease_id uuid not null references {{schema}}.job_leases (id),
  stage text not null check (stage in (
    'extract', 'extract_questions', 'eligibility', 'draft', 'draft_answers',
    'address_read', 'address_checks', 'judge'
  )),
  -- The job's retry round, and the start's number within it (none for a reuse).
  round integer not null,
  attempt smallint check (attempt >= 1),
  -- SHA-256 of what the stage read; an ok run's output is reused for the same hash.
  -- None when the stage's own code failed before it could say what it reads.
  input_hash text,
  -- `abandoned`: left `started` by a killed invocation, found when the job is next claimed.
  outcome text not null check (outcome in ('started', 'ok', 'reused', 'failed', 'abandoned')),
  output jsonb,
  output_hash text,
  -- Whether a failed run may be started again (a timeout) or fails the job at once (a refusal).
  retryable boolean,
  error text,
  started_at timestamptz not null,
  ended_at timestamptz
);
alter table {{schema}}.job_stage_runs enable row level security;

create index job_stage_runs_job_stage on {{schema}}.job_stage_runs (job_id, stage, id);
create index job_stage_runs_job_started on {{schema}}.job_stage_runs (job_id) where outcome = 'started';

-- The references migrations 0005 and 0006 left for this one.
alter table {{schema}}.model_calls
  add constraint model_calls_job_id_fkey foreign key (job_id) references {{schema}}.jobs (id);
alter table {{schema}}.applications
  add constraint applications_job_id_fkey foreign key (job_id) references {{schema}}.jobs (id);
