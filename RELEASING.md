# Releasing the @bayanihan packages

For maintainers. Four packages are on npm under the [`bayanihan`](https://www.npmjs.com/org/bayanihan) org:

| Package | Repository | Depends on |
|---|---|---|
| `@bayanihan/bix` | [bix](https://github.com/Dasig-org/bix) | nothing |
| `@bayanihan/core` | [bayanihan](https://github.com/Dasig-org/bayanihan) `packages/core` | bix |
| `@bayanihan/server` | [bayanihan](https://github.com/Dasig-org/bayanihan) `packages/server` | core |
| `@bayanihan/bayani` | [bayani](https://github.com/Dasig-org/bayani) | core |

## When to release

When there's something worth having: a fix people are waiting for, or a few changes together. Not after every
merge. A merged pull request is done when it's on `main`; it reaches npm with the next release.

## Version numbers

`MAJOR.MINOR.PATCH`. While we're on `0.x`:

- **Patch** (`0.1.0` → `0.1.1`): fixes, nothing anyone has to change.
- **Minor** (`0.1.x` → `0.2.0`): new features, or anything that could break someone using the package.

A published version can never be replaced. A mistake is fixed with the next version.

## Steps

1. Be on an up-to-date `main` with `npm run verify` passing.
2. Bump the version of each package that changed, from its folder:
   ```sh
   npm version patch --no-git-tag-version     # or minor
   ```
   If you bump a package others depend on with a **minor**, update their `^` range too (for example core's
   dependency on bix).
3. Open a pull request with the version bumps and merge it.
4. Publish **in dependency order**: bix, then core, then server and bayani. Only the ones that changed.
   ```sh
   npm publish        # from each package's folder; the build runs on its own (prepack)
   ```
5. Check: `npm view @bayanihan/<name> version`. A brand-new version can take a few minutes to appear.
6. Bump the dependents to the new version where it matters, starting with
   [dasig-app](https://github.com/Dasig-org/dasig-app) `app/package.json`.

## Signing in

You need to be a member of the `bayanihan` npm org with publish rights, and signed in with `npm login`.

npm asks for a second step (passkey or authenticator code) on every publish. That only works in an interactive
terminal, so run `npm publish` yourself in Terminal, not through a script or an assistant.
