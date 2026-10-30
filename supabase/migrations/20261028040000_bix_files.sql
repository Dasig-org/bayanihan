-- Files kept by the group's own server (spec: "Files, home servers and hubs").
-- Bytes live in a file store (local disk now, S3-compatible such as MinIO later); this table knows about them.
create table bix_files (
  hash          text primary key check (hash ~ '^[a-f0-9]{64}$'),
  content_type  text not null,
  size          bigint not null,
  uploaded_by   text not null,
  shows_minors  boolean not null default false,
  created_at    timestamptz not null default now()
);
alter table bix_files enable row level security;
