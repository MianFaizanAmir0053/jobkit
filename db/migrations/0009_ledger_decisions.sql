-- Ledger: the owner's decisions of 2026-10-09 on the second review.

-- Each application names the extracted role it is for (SPEC-extraction,
-- roles[].id), so two roles of one post written alike, such as "Flutter
-- Developer (Lahore)" and "(Karachi)", get separate applications.
alter table {{schema}}.applications add column role_id text;
update {{schema}}.applications set role_id = role_key where role_id is null;
alter table {{schema}}.applications alter column role_id set not null;
alter table {{schema}}.applications drop constraint applications_job_id_role_key_key;
alter table {{schema}}.applications add constraint applications_job_id_role_id_key unique (job_id, role_id);

-- The matches the owner's "apply again" taps covered, as the banner showed
-- them; any other match holds the application again.
alter table {{schema}}.applications add column apply_again_covers text[] not null default '{}';
