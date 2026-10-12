-- Only an email kit is handed to Gmail, so only its outcome answers "Did you
-- change anything in Gmail?". A form or message kit's outcome leaves the
-- answer empty rather than inventing one (ledger spec, "Factual edits and
-- the trust-gate counter").

alter table {{schema}}.draft_outcomes alter column changed_in_gmail drop not null;
alter table {{schema}}.draft_outcomes add constraint draft_outcomes_gmail_answer_check
  check ((kind = 'email') = (changed_in_gmail is not null));
