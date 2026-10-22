-- Ledger: the timing comparison kept honest (ledger spec, "The timing
-- comparison"; the owner's choices, 2026-10-22, after Checkpoint E's doubt
-- review). Each job says whether it is a real job or a test job, and keeps
-- the arm it was drawn into, with its place in the arm sequence, or the
-- earlier job whose arm a post shared again took, and its post's hashes, by
-- which a share is matched again. The one-row measurement table keeps the
-- start of real use once it is recorded, which nothing moves after, and the
-- end of test mode while it is on.

alter table {{schema}}.jobs add column kind text not null default 'real'
  check (kind in ('real', 'test'));
alter table {{schema}}.jobs add column arm text check (arm in ('tool', 'manual'));
alter table {{schema}}.jobs add column arm_index integer check (arm_index >= 0);
alter table {{schema}}.jobs add column arm_from uuid
  references {{schema}}.jobs (id) on delete set null;
-- The SHA-256s of the post's screenshots and of its pasted text, as hex; they
-- go with the pasted text, 30 days after the job came in.
alter table {{schema}}.jobs add column post_hashes text[] not null default '{}';

create table {{schema}}.measurement (
  id smallint primary key default 1 check (id = 1),
  real_use_started_at timestamptz,
  -- The job whose handoff, send or kit that went started real use.
  real_use_job uuid references {{schema}}.jobs (id) on delete set null,
  test_until timestamptz
);
alter table {{schema}}.measurement enable row level security;

-- A job drawn before this migration keeps the arm its application recorded.
update {{schema}}.jobs as job set arm = application.arm
  from {{schema}}.applications as application
 where application.job_id = job.id and application.arm is not null;

-- Real use that started before this migration keeps its start, as it read then.
insert into {{schema}}.measurement (id, real_use_started_at)
select 1, started
  from (select least(
          (select min(least((decisions->'handoff'->'subject'->>'at')::timestamptz,
                            (decisions->'handoff'->'body'->>'at')::timestamptz))
             from {{schema}}.kit_reviews),
          (select min(created_at) from {{schema}}.kit_sends),
          (select min(coalesce(sent_at, submitted_at)) from {{schema}}.applications
            where job_kind = 'real' and arm is distinct from 'manual'
              and coalesce(sent_at, submitted_at) is not null)
        ) as started) as earliest
 where started is not null;
