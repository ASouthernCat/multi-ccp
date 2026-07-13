# Publishing

## Release Preparation

1. Confirm the working tree is on `main` and clean except for intentionally ignored or untracked local files.
2. Update `CHANGELOG.md` with the release notes.
3. Update the version in `package.json` and the two root version fields in `package-lock.json`.
4. Confirm `package.json` metadata such as `author`, `repository`, `homepage`, `bugs`, `publishConfig`, and package version.
5. For gateway releases, update README guidance, migration notes, and any protocol/logging limitations before tagging.

## Package Checks

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Also inspect the `npm pack --dry-run` output and confirm the package contains the built `dist` files, both READMEs, `LICENSE`, and `CHANGELOG.md`, but not local profile data, scratch files, temporary live-test files, or Claude workspace state.

## Git Release

```bash
git status --short --branch
git diff --check
git add CHANGELOG.md package.json package-lock.json README.md README.zh-CN.md docs
# include any release-blocking source/test fixes separately or in an earlier focused commit
git commit -m "chore(release): <version>"
git tag -a "v<version>" -m "v<version>"
git push origin main "v<version>"
```

Use the existing release commit style, for example `chore(release): 0.3.0`. Prefer annotated `v<version>` tags for new releases.

## Publish

```bash
npm login
npm publish --access public
```

`prepublishOnly` runs `npm run build && npm test` again during `npm publish`, but the explicit package checks above should still be run before tagging and publishing.
