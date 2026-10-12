-- Draft anyway answers one role on one extraction: the role the owner was
-- shown, and the output hash of the extract run that read it. A later
-- extraction, as after "Read it again", or another role, asks again
-- (extraction spec, "Stage eligibility"). A decision recorded before these
-- columns answers nothing, so such a job asks again if its check reruns.

alter table {{schema}}.jobs add column eligibility_decision_role text;
alter table {{schema}}.jobs add column eligibility_decision_output text;
