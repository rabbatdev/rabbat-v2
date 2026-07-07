/// <reference types="vite/client" />

declare module "virtual:rabbat/manifest" {
  import type { PageManifestClientEntry } from "@rabbat/react";
  export const pages: PageManifestClientEntry[];
  export const manifest: { pages: PageManifestClientEntry[] };
}

declare const __BUILD_ID__: string;
