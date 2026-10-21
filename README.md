# NeonSweep

A local Windows desktop workspace for selecting Discord conversations, filtering content, previewing matches, and deleting the items you approve. NeonSweep is an independent application, with no affiliation to Discord or Redact.

## Install

Download **NeonSweep-Setup** from [Releases](https://github.com/Djay92/neonsweep/releases/latest) and install it once. The installer creates a persistent NeonSweep shortcut. Existing portable users should finish or stop their current job and close the old app before launching NeonSweep.

Saved accounts and archives stay in the existing `%APPDATA%\discord-redact-pro` profile. The folder name is retained to preserve encrypted account storage during the rename. Uninstalling leaves that data intact.

## Use

1. **Account:** connect a saved account, sign in, or enter your account token.
2. **Conversations:** choose messages, reactions, or an extracted data package; select conversations or enter IDs.
3. **Rules:** optionally narrow dates, content types, keywords, and mentions. Pinned messages are kept by default.
4. **Review:** check the setup and start a preview. Uncheck anything to keep, then choose **Delete checked**.

Direct deletion is a separate choice with confirmation. It first collects matches, then deletes a known batch. Preview never edits or deletes messages. Elapsed time, measured speed, Discord cooldowns, remaining actions, and approximate deletion completion stay on the results screen. History previews have no exact ETA when the history total is unknown.

## Automatic updates

The installed app checks public GitHub Releases shortly after launch and every six hours. Updates download in the background and install on normal exit, or through **Updates → Restart to update**. Restart is blocked during an active cleanup job. Development and portable builds clearly show that automatic installation is unavailable.

The client contains no GitHub credentials. Electron-builder generates the update configuration and `latest.yml`; electron-updater uses HTTPS and verifies the downloaded artifact's manifest checksum. Windows signing is supported by the release workflow when certificate secrets are configured; releases without a certificate are unsigned.

## Develop

```powershell
npm ci
npm test
npm run test:electron
npm start
```

The Electron smoke test uses isolated temporary account storage and simulated requests. It never contacts Discord or deletes real messages.

```powershell
npm run dist           # Windows installer with auto-update support
npm run dist:portable  # Optional portable build; no automatic installation
```

## Push an update

Change the code, then bump the version and push:

```powershell
npm version patch
git push origin main --follow-tags
```

The Windows Actions workflow tests the app and publishes a release when that package version has no complete release. It uploads the installer, blockmap, and `latest.yml` to a draft, checks all three assets, then publishes it. Failed or partial releases can be retried. Installed copies discover the published update automatically. Pushing changes without a version bump runs tests but does not replace an existing complete release.

Optional repository secrets `WINDOWS_CERTIFICATE` (PFX URL or base64) and `WINDOWS_CERTIFICATE_PASSWORD` enable Windows signing. Keep certificates and tokens out of source control. The workflow uses GitHub's ephemeral `GITHUB_TOKEN` only while publishing.

Updater references: [Electron-builder auto updates](https://www.electron.build/v26/docs/features/auto-update/), [publishing](https://www.electron.build/v26/docs/publish/).
