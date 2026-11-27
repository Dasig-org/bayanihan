# Contributing to Bayanihan Core and Server

Salamat for helping. This is the engine under the Dasig app: the rules that check every change, and the server that
stores records. It's young and shaped with the volunteer groups in the Dasig pilot.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Pick up an issue** labelled [`good first issue`](https://github.com/Dasig-org/bayanihan/labels/good%20first%20issue)
  or [`help wanted`](https://github.com/Dasig-org/bayanihan/labels/help%20wanted).
- **Write tests** for a rule in Core that isn't covered yet. Rules are pure functions, so tests are short.
- **Self-host it** with [`deploy/`](deploy) and tell us what was hard.
- **Review the security model:** permissions, signatures, what a person may see. Report problems privately
  ([`SECURITY.md`](SECURITY.md)).

## Before you start

- **Small fixes and tests:** open a pull request straight away.
- **Anything bigger** (a new endpoint, a change to a rule, a database migration): open an issue first and wait until a
  maintainer agrees on the approach.
- **If it changes what records mean,** it starts in [BIX](https://github.com/Dasig-org/bix), not here. Core implements
  the spec; it doesn't invent it.
- **To work on an issue,** comment on it so it can be assigned to you. If there's no news after two weeks, it goes back
  to the pool. No hard feelings.

## Set up

You need Node.js 22.13 or newer. [BIX](https://github.com/Dasig-org/bix) comes from npm as `@bayanihan/bix`.

```sh
git clone https://github.com/<you>/bayanihan.git     # your fork
cd bayanihan && npm install
npm run verify        # typecheck + tests; should pass before you change anything
```

To run the server against Postgres you also need Docker and the Supabase CLI: see
[`packages/server/README.md`](packages/server/README.md). For most Core work, SQLite and the tests are enough:

```sh
BIX_DB=./data/bix.db BIX_OPEN_JOIN=1 npm start -w @bayanihan/server   # http://localhost:8787/metadata
```

## Where things are

| Path | What |
|---|---|
| `packages/core/src/` | The rules: lifecycles, permissions, claims, signatures, votes, report figures, project memory. **No storage, no network.** |
| `packages/server/` | The BIX API, storage (SQLite or Postgres), sign-in, files |
| `supabase/migrations/` | Postgres schema |
| `deploy/` | Docker, Caddy and Litestream for self-hosting |

## Rules the code keeps

- **Core stays pure.** No I/O, no clock reads you can't pass in, no network. It runs on phones (Hermes), so no `eval`
  and no Node-only APIs.
- **Every change goes through Core.** The server never writes a record Core hasn't checked.
- **A private record you can't see answers 404,** as if it doesn't exist.
- **Privacy is part of the design.** People served are counts, never names; small numbers are hidden in public;
  photos of children never leave the group. Changes that weaken this won't be merged.
- **Tests use fictional groups** (for instance "Lahug Uplands Runners Club"), never real people or real groups' data.
- **Plain language** in any error message a person might see.

## Open a pull request

1. Branch from `main` in your fork: `git switch -c core-claim-tests`.
2. Keep it to one change, with tests where code changes.
3. Run `npm run verify` and say so in the pull request. The same checks run on every pull request.
4. Fill in the pull request template.

## What happens next

- A maintainer reviews it, usually **within a week**. Only maintainers can merge; every change to `main` needs an
  approving review.
- You may be asked for changes. That's normal, not a rejection.
- We squash-merge, so your pull request becomes one commit on `main`, credited to you.

## Your contribution's licence

By contributing you agree that your contribution is licensed under the licence of the part you change: **Apache-2.0**
for Bayanihan Core (`packages/core`), **AGPL-3.0** for Bayanihan Server and everything else in this repository (see
the README's Licence section).

Sign off each commit (`git commit -s`), which adds a `Signed-off-by:` line. It certifies the
[Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or otherwise have the
right to submit it under these licences.

## Questions

[Dasig-org Discussions](https://github.com/orgs/Dasig-org/discussions), or hello@dasig.org. Security and privacy
problems: see [`SECURITY.md`](SECURITY.md), never a public issue.
