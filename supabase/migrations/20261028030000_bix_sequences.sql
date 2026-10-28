-- Short references people can say and type (LU 2027-24). One counter per prefix, allocated by the server.
create table bix_sequences (
  prefix text primary key,
  next   integer not null default 1
);
alter table bix_sequences enable row level security;
