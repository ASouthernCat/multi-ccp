# Publishing

## Package Checks

```bash
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

## Publish

```bash
npm login
npm publish --access public
```

Before publishing, confirm the package name is available and update `author`, repository metadata, and version in `package.json`.
