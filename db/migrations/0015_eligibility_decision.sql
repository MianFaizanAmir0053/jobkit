-- The owner's answer to a role that looks closed to them (extraction spec,
-- "Stage eligibility"): Draft anyway. Eligibility's input hash covers it, and
-- with it the chain goes on to drafting whatever the check finds.

alter table {{schema}}.jobs add column eligibility_decision text
  check (eligibility_decision in ('draft_anyway'));
