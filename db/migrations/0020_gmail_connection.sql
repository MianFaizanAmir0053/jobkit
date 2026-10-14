-- The owner's Gmail connection for one-click send (decisions A20): one row,
-- the account it sends as, the refresh token sealed with GMAIL_TOKEN_KEY
-- (AES-256-GCM; the token itself is never stored), the scopes Google
-- granted, and when it was connected. Disconnect deletes the row.

create table {{schema}}.gmail_connection (
  id smallint primary key default 1 check (id = 1),
  email text not null,
  refresh_token_sealed text not null,
  scopes text[] not null,
  connected_at timestamptz not null
);
alter table {{schema}}.gmail_connection enable row level security;
