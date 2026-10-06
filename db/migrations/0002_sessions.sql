-- Platform: the pinned owner and the sessions (platform spec B2).

-- One row: Google's stable `sub` for the owner, pinned by the first admitted sign-in.
create table {{schema}}.owner (
  id smallint primary key default 1 check (id = 1),
  google_sub text not null,
  pinned_at timestamptz not null
);
alter table {{schema}}.owner enable row level security;

-- The cookie holds a random token; the row keeps only its SHA-256 hash.
-- Lifetimes are absolute: expires_at is set once, when the row is created.
create table {{schema}}.sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  kind text not null check (kind in ('google', 'paired')),
  label text not null,
  created_at timestamptz not null,
  last_seen_at timestamptz not null,
  expires_at timestamptz not null,
  approved_at timestamptz,
  google_auth_at timestamptz,
  -- A Google sign-in approves its own session; only a paired phone waits for approval.
  check (kind = 'paired' or (approved_at is not null and google_auth_at is not null)),
  check (kind = 'google' or google_auth_at is null)
);
alter table {{schema}}.sessions enable row level security;
