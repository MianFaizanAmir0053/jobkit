-- Extraction (extraction spec): the owner's answers that its stages read.
-- "This is a job post" re-runs extract with the owner's confirmation, which
-- extract's input hash covers; a post with several roles waits until the
-- owner picks the one to apply for, which eligibility and drafting read.

alter table {{schema}}.jobs add column post_confirmed_at timestamptz;
-- A role ID from the extracted record (P1, P2, …); none while a post's only
-- role is chosen automatically.
alter table {{schema}}.jobs add column chosen_role text;
