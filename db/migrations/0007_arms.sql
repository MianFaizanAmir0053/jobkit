-- Ledger: the seeded sequence that assigns timing arms (ledger spec, "The
-- timing comparison"; amendment A13). One row: the seed, drawn once, and the
-- next place in the sequence. Each new job during real use takes the next
-- place, so the assignment can be replayed and nobody can pick an arm.
create table {{schema}}.arm_sequence (
  id smallint primary key default 1 check (id = 1),
  seed bytea not null,
  next_index integer not null check (next_index >= 0)
);
alter table {{schema}}.arm_sequence enable row level security;
