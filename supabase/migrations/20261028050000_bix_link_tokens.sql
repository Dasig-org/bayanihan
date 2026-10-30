-- The secret part of a ShareLink. Kept out of the BIX record (spec: "The token is never stored in the record").
create table bix_link_tokens (
  token_hash text primary key,
  link_id    text not null unique,
  created_at timestamptz not null default now()
);
alter table bix_link_tokens enable row level security;
