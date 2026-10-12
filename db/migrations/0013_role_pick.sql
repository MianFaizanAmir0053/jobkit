-- A role pick belongs to the extraction it was made on: the output hash of
-- the extract run whose roles the owner chose from. A later extraction, as
-- after new screenshots, may list other roles under the same IDs, so a
-- pick made on another output is ignored (extraction spec, "Stage
-- needs_role_pick").

alter table {{schema}}.jobs add column chosen_role_output text;
