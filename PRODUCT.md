# NeonSweep

NeonSweep is an independent, local Windows Electron application for reviewing and cleaning up Discord messages and reactions. It supports live conversation history, server search, closed DMs by user ID, and extracted Discord message JSON packages. It is not affiliated with Discord or Redact.

The user requested a complete replacement of the former Redact-inspired UI with a coherent cyberpunk direction and automatic releases. The old visual reference is superseded. Organize work into Account → Conversations → Rules → Review, followed by a dedicated results screen. Use dark ink surfaces, readable body typography, cyan action accents, restrained yellow details, and clear native controls. Do not recreate third-party branding, subscription limits, or unsupported features.

Preview never edits or deletes. The default path is preview, inspect, uncheck what stays, then explicitly delete the approved selection. Direct deletion is a separate choice with confirmation and collects a complete batch before sending deletion requests. Preserve author checks, filters, advanced moderation options, all three pipelines, and cancellation.

Known deletion batches show remaining work, measured speed, elapsed time, and approximate completion adjusted to Discord cooldowns. History preview totals may be unknown; do not invent an exact estimate. Keep progress visible above the queue and request details in a disclosure.

The Windows installer checks public GitHub Releases and downloads updates in the background. Install on user-requested restart or normal exit, never force a restart during an active job. Development and portable builds explain that automatic installation needs the installed app. Source and releases live at https://github.com/Djay92/neonsweep. A push with a new package version runs checks, builds NSIS, and publishes updater artifacts automatically.

The legacy %APPDATA%\discord-redact-pro profile and internal application ID remain stable to preserve saved accounts and archives through the rename. Public source excludes account data, archives, tokens, local diagnostics, generated installers, and temporary captures.

Supported desktop windows start at 1100 × 760. Styling, font files, and icons are local packaged assets. Keyboard focus, reduced motion, empty states, connection errors, disabled actions, and loading states work throughout the guided flow.
