-- A pick made before migration 0013 was made on the extraction current
-- then, which is still the latest finished extract run of its job.

update {{schema}}.jobs as job
   set chosen_role_output = (
     select run.output_hash from {{schema}}.job_stage_runs as run
      where run.job_id = job.id and run.stage = 'extract' and run.outcome in ('ok', 'reused')
      order by run.id desc
      limit 1
   )
 where job.chosen_role is not null and job.chosen_role_output is null;
