// UploadThing file router for en. The client persists the returned URL(s) to the
// right place (avatar/cover/icon field, or a message's attachments) via a normal
// mutation, so we never depend on UploadThing's server callback (which can't
// reach localhost in dev).

import { createUploadthing, type FileRouter, UploadThingError } from "uploadthing/server";

const f = createUploadthing();

/** `resolveUser` validates the request's session cookie/bearer → user id. */
export function makeUploadRouter(resolveUser: (req: Request) => Promise<string | null>) {
  const auth = async ({ req }: { req: Request }) => {
    const userId = await resolveUser(req);
    if (!userId) throw new UploadThingError("Sign in to upload");
    return { userId };
  };
  return {
    // Profile/orbit imagery (avatar, cover, orbit icon) — one cropped image.
    image: f({ image: { maxFileSize: "8MB", maxFileCount: 1 } })
      .middleware(auth)
      .onUploadComplete(({ file }) => ({ url: file.ufsUrl })),
    // Message attachments — images AND videos, up to 4 per message (a small
    // gallery). The binding limit is 5 MB/file, enforced client-side before
    // upload (UploadThing's maxFileSize only accepts power-of-2 presets, so the
    // route ceiling is 8 MB and the client rejects anything over 5 MB first).
    messageMedia: f({
      image: { maxFileSize: "8MB", maxFileCount: 4 },
      video: { maxFileSize: "8MB", maxFileCount: 4 },
    })
      .middleware(auth)
      .onUploadComplete(({ file }) => ({
        url: file.ufsUrl,
        type: file.type,
        name: file.name,
        size: file.size,
      })),
  } satisfies FileRouter;
}

export type UploadRouter = ReturnType<typeof makeUploadRouter>;
