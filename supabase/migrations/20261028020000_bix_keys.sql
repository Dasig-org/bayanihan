-- Signing keys, one per group (or person, for personal work). The private key never leaves the server;
-- the public key is published at GET /$keys/{owner}. A hub will hold its own key after v0.
create table bix_keys (
  owner        text primary key,          -- e.g. Organization/cebu-wp
  key_id       text not null unique,
  public_jwk   jsonb not null,
  private_jwk  jsonb not null,
  created_at   timestamptz not null default now()
);
alter table bix_keys enable row level security;
