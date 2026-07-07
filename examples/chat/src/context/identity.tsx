import { createContext, useContext } from "react";

export interface Identity {
  userId: string;
  /** The user's display name (non-unique). The unique @handle lives in
   *  `profile.me().username`, not here (it isn't carried on the session). */
  displayName: string;
  email: string;
  image: string | null;
  signOut: () => void;
}

export const IdentityContext = createContext<Identity | null>(null);

export function useIdentity(): Identity {
  const ctx = useContext(IdentityContext);
  if (!ctx) throw new Error("useIdentity must be used within IdentityContext");
  return ctx;
}
