-- How each email kit fared once handed off (ledger spec, "Records" and
-- "Factual edits and the trust-gate counter"): the sentences and fields the
-- owner changed in jobkit, whether they changed anything in Gmail (asked at
-- Mark sent), and so whether the outcome is a factual edit. One row per
-- application, written by the review module at Mark sent.

create table {{schema}}.draft_outcomes (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null unique references {{schema}}.applications (id) on delete cascade,
  job_id uuid not null references {{schema}}.jobs (id),
  kind text not null check (kind in ('email', 'form', 'message')),
  -- Block IDs and field names the owner changed in jobkit; none until the editor exists.
  changed text[] not null default '{}',
  changed_in_gmail boolean not null,
  factual_edit boolean not null,
  recorded_at timestamptz not null
);
alter table {{schema}}.draft_outcomes enable row level security;
