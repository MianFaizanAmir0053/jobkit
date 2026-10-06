-- Platform: QR pairing (platform spec B3).

-- A pairing token works once, for two minutes, while the google session that
-- made it exists. The row keeps only the token's hash.
create table {{schema}}.pairing_tokens (
  token_hash text primary key,
  created_by uuid not null references {{schema}}.sessions (id) on delete cascade,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
alter table {{schema}}.pairing_tokens enable row level security;

-- A redeemed phone's session waits here until the session that made the token
-- types the phone's six-digit code. If that session goes, no one can approve,
-- and the phone's session times out with the rest.
create table {{schema}}.pending_pairings (
  session_id uuid primary key references {{schema}}.sessions (id) on delete cascade,
  approver_session_id uuid not null references {{schema}}.sessions (id) on delete cascade,
  code_hash text not null,
  attempts smallint not null default 0,
  created_at timestamptz not null
);
alter table {{schema}}.pending_pairings enable row level security;
