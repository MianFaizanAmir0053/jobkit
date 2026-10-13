-- The owner's decisions on a kit (review spec, "The outbound gate"): the
-- sentences they marked "I checked this", the address or number they typed,
-- the attachments they ticked, and "Continue anyway" on a scam warning, kept
-- as one row per job and role (the owner's choice, 2026-10-14), with the
-- gate's open reasons as the server last found them. "Apply again" stays on
-- the application row, where the ledger keeps it.

create table {{schema}}.kit_reviews (
  job_id uuid not null references {{schema}}.jobs (id),
  role_id text not null,
  decisions jsonb not null,
  gate jsonb not null,
  updated_at timestamptz not null,
  primary key (job_id, role_id)
);
alter table {{schema}}.kit_reviews enable row level security;
