-- Up Migration
-- Deferred triggers execute at commit, after the leased dispatcher function restores
-- its caller role. The guard needs owner privileges for its fixed tenant/ID lookup;
-- the dispatcher itself retains no direct business-table privileges.
ALTER FUNCTION public.validate_index_job() SECURITY DEFINER;

-- Down Migration
ALTER FUNCTION public.validate_index_job() SECURITY INVOKER;
