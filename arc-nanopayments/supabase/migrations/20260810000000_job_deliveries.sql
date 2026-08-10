-- job_deliveries: one row per job that has been delivered, enforcing one-delivery-per-job.
--
-- Why this exists: withGateway used to authorize a delivery purely on the job being Active
-- on-chain. A job stays Active until the buyer calls release(), so the same jobId and
-- signature could be replayed indefinitely — one payment bought unlimited copies of the
-- paid content, and the buyer's rational move was to never release at all (take N copies,
-- then let claimTimeout settle once). Nothing anywhere marked a job as already delivered.
--
-- The primary key IS the enforcement: the seller inserts before delivering, and a duplicate
-- job_id raises a unique violation that the route turns into a 409. Doing this in the
-- database rather than with a read-then-write check in the route matters, because two
-- concurrent requests for the same jobId would both pass a read-then-write check.
create table public.job_deliveries (
  -- Text, not bigint: jobIds are uint256 on-chain and would overflow a bigint. The same
  -- reason lib/x402.ts stringifies them before writing to payment_events.raw.
  job_id text primary key,
  delivered_at timestamptz not null default now(),
  endpoint text not null,
  buyer text not null
);

alter table public.job_deliveries enable row level security;

create policy "Allow public read access"
  on public.job_deliveries for select
  using (true);

create policy "Allow service inserts"
  on public.job_deliveries for insert
  to service_role
  with check (true);

-- Explicit grants, for the same reason 20260726000000_explicit_grants.sql exists: a fresh
-- local stack does not reliably pick up Supabase's default API-role privileges, and the
-- failure mode is a runtime "permission denied" rather than a migration error.
grant select on public.job_deliveries to anon, authenticated, service_role;
grant insert on public.job_deliveries to service_role;
