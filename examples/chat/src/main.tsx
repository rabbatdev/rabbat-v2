import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { FunctionsClient } from "@rabbat/client"
import { RabbatProvider } from "@rabbat/react"
import App from "./App.js"

// The live sync socket is same-origin: @rabbat/vite routes /ws to the Worker /
// Durable Object. `persist: true` enables the optional IndexedDB LRU cache.
const url = `${location.origin.replace(/^http/, "ws")}/ws`
const client = new FunctionsClient({ url, persist: true })

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RabbatProvider client={client}>
      <App />
    </RabbatProvider>
  </StrictMode>,
)
