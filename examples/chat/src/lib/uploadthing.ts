// UploadThing client helpers, typed against the server's file router. The app
// reaches the upload endpoint same-origin (Vite proxies /api/uploadthing →
// :3654). `import type` keeps the server module out of the browser bundle.

import { generateReactHelpers } from "@uploadthing/react";

import type { UploadRouter } from "../../rabbat/functions/uploadthing";

export const { useUploadThing, uploadFiles } = generateReactHelpers<UploadRouter>({
  url: "/api/uploadthing",
});
