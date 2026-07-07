/// <reference types="vite/client" />

// Build identifier baked in at build time (see vite.config.ts). The running app
// compares it against /version.json to detect a newer deploy. See use-version-check.
declare const __BUILD_ID__: string;
