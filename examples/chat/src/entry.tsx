import { manifest } from "virtual:rabbat/manifest";
import { boot } from "@rabbat/react/entry-client";

import "./styles.css";

// Rabbat's client bootstrap: create the FunctionsClient, hydrate the SSR'd page,
// and take over client-side navigation. Providers + auth gate live in pages/layout.
// persist: warm queries from the IndexedDB LRU cache so swapping channels/orbits
// renders from disk instead of flashing skeletons, then goes live.
boot(manifest, { persist: true });
