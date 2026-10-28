-- Links a sign-in account (Supabase Auth user) to a BIX Person. Accounts are not part of BIX;
-- this table is how this server knows which Person is calling.
create table bix_accounts (
  auth_user_id uuid primary key,
  person_id    text not null unique,
  created_at   timestamptz not null default now()
);
alter table bix_accounts enable row level security;
