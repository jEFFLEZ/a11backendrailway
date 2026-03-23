# Publishing @qflush/qflush

This document explains how to publish the `@qflush/qflush` package to npm and includes recommended `package.json` fields.

NOTE: The public npm listing (package page) is currently under reconstruction. The package can still be published and installed via `npm install @qflush/qflush`, but the npm website display may be incomplete until the rebuild is finished.

Checklist before publishing:

- Bump `version` in `package.json` if republishing.
- Ensure `dist/index.js` exists and starts with `#!/usr/bin/env node`.
- Run `npm run build` and verify `dist` contains compiled JS and `.d.ts` files.
- Run `node dist/index.js --help` to verify CLI runs.
- Run `npm pack` to inspect the tarball contents before publishing.
- Ensure `package.json` `bin` points to `dist/index.js`.
- If using `.npmignore`, ensure it does not exclude `dist`.
- Confirm `prepare` script in `package.json` is present to auto-build on publish.

Recommended package.json fields:

```json
{
  "name": "@qflush/qflush",
  "version": "0.0.0",
  "description": "QFLUSH — The Funesterie Runtime System",
  "main": "dist/index.js",
  "bin": { "qflush": "dist/index.js" },
  "files": ["dist", "README.md"],
  "publishConfig": { "access": "public" }
}
```

Publish steps:

1. Login to npm: `npm login` (use account that owns `@qflush` scope)
2. From project root `cd qflush`
3. Build: `npm run build`
4. Publish: `npm publish --access public`

Testing globally without publishing:

- Link locally: `cd qflush && npm link`
- Test: `qflush --help` or `qflush start` or `qflush checksum list`
- Remove link: `npm unlink -g @qflush/qflush`

Notes on 2FA:

- If your npm account requires 2FA for publishing, you'll be prompted for the OTP.

Troubleshooting:

- If publish fails due to package name, ensure the scope `@qflush` exists and you have permission to publish under it.
- If `dist` missing on publish, `prepare` should build, but check logs for errors.

