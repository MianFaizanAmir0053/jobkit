-- Profile: immutable versions of the owner's profile (profile spec,
-- "Seeding"). Each holds the validated document, unapproved items included,
-- which never leave the profile module; drafts keep the version they used,
-- so their citations still resolve after the profile changes.
create table {{schema}}.profile_versions (
  id uuid primary key default gen_random_uuid(),
  -- SHA-256 of the profile file, the CV and the style examples together.
  hash text not null unique,
  document jsonb not null,
  style_examples text[] not null,
  cv_path text not null,
  cv_label text not null,
  created_at timestamptz not null,
  active boolean not null default false
);
alter table {{schema}}.profile_versions enable row level security;

-- One active version at a time; making an older one active is a rollback.
create unique index profile_versions_one_active on {{schema}}.profile_versions ((true)) where active;
