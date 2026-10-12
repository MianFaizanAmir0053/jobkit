-- Intake: a job's images and pasted text (intake spec, "Storage and
-- retention"). Image bytes never pass through a route handler: the phone
-- uploads each file to its own signed URL, and the server checks what
-- arrived before the job is queued.

create table {{schema}}.job_images (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references {{schema}}.jobs (id),
  -- The image's place among the job's images of its purpose, from 0, as the owner chose them.
  position smallint not null check (position >= 0),
  purpose text not null check (purpose in ('post', 'form')),
  storage_path text not null unique,
  content_type text not null check (content_type in ('image/webp', 'image/jpeg', 'image/png')),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  bytes integer not null check (bytes > 0),
  sha256 text not null,
  tile_count smallint not null check (tile_count >= 1),
  created_at timestamptz not null,
  purge_after timestamptz not null,
  kept_for_eval boolean not null default false,
  unique (job_id, purpose, position)
);
alter table {{schema}}.job_images enable row level security;

-- Text the owner pasted with the job; the purge clears it after 30 days.
alter table {{schema}}.jobs add column pasted_text text;
