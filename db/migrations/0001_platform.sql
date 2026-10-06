-- Platform: the keep-alive heartbeat (platform spec B6).
-- Every table keeps row-level security on with no policies (platform spec B1),
-- so Supabase's public roles read nothing even if the Data API were exposed.

create table {{schema}}.heartbeat (
  id smallint primary key default 1 check (id = 1),
  touched_at timestamptz not null default now()
);
alter table {{schema}}.heartbeat enable row level security;

insert into {{schema}}.heartbeat (id) values (1);
