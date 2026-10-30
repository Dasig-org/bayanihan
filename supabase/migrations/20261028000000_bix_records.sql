-- Bayanihan Server storage, v0. One table of current records, one of every version.
-- Every write goes through Bayanihan Core first; the database guards versions and history.

create table bix_records (
  type        text        not null,
  id          text        not null,
  version     integer     not null check (version >= 1),
  resource    jsonb       not null,
  updated_at  timestamptz not null default now(),
  primary key (type, id),
  check (resource->>'resourceType' = type),
  check (resource->>'id' = id),
  check ((resource->'meta'->>'version')::int = version)
);
create index bix_records_resource_gin on bix_records using gin (resource jsonb_path_ops);
create index bix_records_org on bix_records ((resource->'organization'->>'reference'));
create index bix_records_owner on bix_records ((resource->'owner'->>'reference'));

-- Append-only history: every version of every record (spec, "Provenance on every change").
create table bix_history (
  type        text        not null,
  id          text        not null,
  version     integer     not null,
  resource    jsonb       not null,
  recorded_at timestamptz not null default now(),
  primary key (type, id, version)
);
create or replace function bix_history_is_append_only() returns trigger language plpgsql as $$
begin raise exception 'bix_history is append-only'; end $$;
create trigger bix_history_no_update before update or delete on bix_history
  for each row execute function bix_history_is_append_only();

-- v0: the server is the only writer. No direct client access; row-level security on, no policies.
alter table bix_records enable row level security;
alter table bix_history enable row level security;
