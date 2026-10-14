-- One-click sends (decisions A20): each "Approve & send" of a kit, the kit
-- and the address it was pressed on, scheduled ten seconds ahead so the owner
-- can undo it, then sending, and sent with Gmail's message and thread IDs or
-- failed with the reason. At most one send of a job's role is live
-- (scheduled, sending or sent), so a second tap never sends twice.

create table {{schema}}.kit_sends (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references {{schema}}.jobs (id),
  role_id text not null,
  kit text not null,
  to_address text not null,
  status text not null check (status in ('scheduled', 'cancelled', 'sending', 'sent', 'failed')),
  send_at timestamptz not null,
  gmail_message_id text,
  gmail_thread_id text,
  error text,
  -- The session whose tap it was, as the ledger's status changes keep it.
  session_id uuid references {{schema}}.sessions (id) on delete set null,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create unique index kit_sends_one_live on {{schema}}.kit_sends (job_id, role_id)
  where status in ('scheduled', 'sending', 'sent');
alter table {{schema}}.kit_sends enable row level security;
