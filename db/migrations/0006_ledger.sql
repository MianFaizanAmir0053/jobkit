-- Ledger: applications, earlier applications and the status audit (ledger
-- spec, "Records").

-- One per job and role, created when the role is chosen.
create table {{schema}}.applications (
  id uuid primary key default gen_random_uuid(),
  -- The runner's migration adds the reference to jobs.
  job_id uuid not null,
  company text not null,
  role text not null,
  company_key text,
  role_key text not null,
  -- SHA-256 of the company key, a bar and the role key; absent without a company.
  company_role_hash text,
  -- The application's email address or phone number, as written.
  address text,
  route text check (route in ('email', 'form', 'message')),
  -- Word trigrams of the role's requirement texts, for the post-similarity check.
  post_fingerprint text[] not null default '{}',
  status text not null check (status in ('open', 'kit_ready', 'sent', 'submitted', 'skipped', 'bounced')),
  opened_at timestamptz not null,
  kit_ready_at timestamptz,
  sent_at timestamptz,
  submitted_at timestamptz,
  skipped_at timestamptz,
  bounced_at timestamptz,
  status_changed_at timestamptz not null,
  -- When the owner tapped "apply again" past the duplicate matches.
  apply_again_at timestamptz,
  cv_label text,
  profile_version text,
  final_draft jsonb,
  -- The timing arm during real use; none before it.
  arm text check (arm in ('tool', 'manual')),
  job_kind text not null default 'real' check (job_kind in ('real', 'evaluation', 'test')),
  unique (job_id, role_key)
);
alter table {{schema}}.applications enable row level security;

create index applications_company_role_hash on {{schema}}.applications (company_role_hash);

-- Applications made before jobkit, imported from the owner's list; keyed on
-- company-role hash and date, so importing twice adds nothing.
create table {{schema}}.earlier_applications (
  id uuid primary key default gen_random_uuid(),
  company text not null,
  role text not null,
  company_role_hash text not null,
  applied_on date not null,
  route text not null check (route in ('email', 'form', 'message')),
  address text,
  imported_at timestamptz not null,
  unique (company_role_hash, applied_on)
);
alter table {{schema}}.earlier_applications enable row level security;

-- An audit row for every status change, with the session that made it; a
-- change the job made itself has none.
create table {{schema}}.status_changes (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references {{schema}}.applications (id) on delete cascade,
  from_status text,
  to_status text not null,
  changed_at timestamptz not null,
  session_id uuid references {{schema}}.sessions (id) on delete set null
);
alter table {{schema}}.status_changes enable row level security;

create index status_changes_application on {{schema}}.status_changes (application_id, changed_at);
