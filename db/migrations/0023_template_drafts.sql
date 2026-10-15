-- Drafts from the owner's approved email templates (decisions A21, with
-- amendment A22): drafting runs the `templates` stage first, code only, with
-- the address stages beside it. When a template covers enough of the role,
-- the kit is ready with up to two template drafts; when none does, `draft`
-- runs as before. The review row keeps the draft the owner picked among the
-- kit's drafts (none until they pick one, so the page shows the one it
-- recommends), and the sentences and flags they marked on each of the
-- others, by the draft's kit key, so going back to one restores them. An
-- email's outcome records which draft went: Gemini's, or a template's by its
-- ID; none before the templates.

alter table {{schema}}.jobs drop constraint jobs_pending_stage_check;
alter table {{schema}}.jobs add constraint jobs_pending_stage_check check (pending_stage in (
  'extract', 'extract_questions', 'eligibility', 'templates', 'draft', 'draft_answers', 'judge'
));
alter table {{schema}}.jobs drop constraint jobs_failed_stage_check;
alter table {{schema}}.jobs add constraint jobs_failed_stage_check check (failed_stage in (
  'extract', 'extract_questions', 'eligibility', 'templates', 'draft', 'draft_answers',
  'address_read', 'address_checks', 'judge'
));
alter table {{schema}}.job_stage_runs drop constraint job_stage_runs_stage_check;
alter table {{schema}}.job_stage_runs add constraint job_stage_runs_stage_check check (stage in (
  'extract', 'extract_questions', 'eligibility', 'templates', 'draft', 'draft_answers',
  'address_read', 'address_checks', 'judge'
));

alter table {{schema}}.kit_reviews add column picked_draft text;
alter table {{schema}}.kit_reviews add column draft_checks jsonb not null default '{}'::jsonb;

alter table {{schema}}.draft_outcomes add column draft text;
