-- Platform: one row per model request attempt (platform spec B4).
-- An attempt is inserted as `started`, with its provisional cost, before the
-- request is sent, and completed afterwards; a killed invocation leaves the
-- row `started`, and the runner marks it `abandoned` when the job is next
-- claimed, so its provisional cost still counts towards the cap.
create table {{schema}}.model_calls (
  id uuid primary key default gen_random_uuid(),
  -- The runner's migration adds the reference to jobs; evaluations never write here.
  job_id uuid,
  stage text not null,
  attempt smallint not null check (attempt >= 1),
  provider text not null check (provider in ('anthropic', 'gemini')),
  requested_model text not null,
  -- The model that answered: a refusal fallback can differ from the one requested.
  answered_model text,
  request_id text,
  started_at timestamptz not null,
  ended_at timestamptz,
  outcome text not null check (outcome in (
    'started', 'ok', 'refused', 'refused-cap', 'timeout', 'rate-limited', 'server-error',
    'connection-error', 'client-error', 'invalid-output', 'max-tokens', 'abandoned'
  )),
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  -- Each model run with its tokens and cost, when a refusal fell back to another model.
  iterations jsonb,
  cost_usd numeric(12, 6) not null default 0,
  -- True while the cost is the upper bound: input at the input rate plus max_tokens at the output rate.
  cost_provisional boolean not null default false,
  -- False when a model missing from the price table was charged at the highest rates.
  price_known boolean not null default true,
  error text
);
alter table {{schema}}.model_calls enable row level security;

-- The monthly cap sums costs by start time; the runner finds a job's started rows.
create index model_calls_started_at on {{schema}}.model_calls (started_at);
create index model_calls_job_started on {{schema}}.model_calls (job_id) where outcome = 'started';
