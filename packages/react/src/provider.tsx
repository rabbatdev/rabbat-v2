import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react"
import { FunctionsClient, type ConnectionStatus, type FunctionsClientOptions } from "@rabbat/client"

const ClientContext = createContext<FunctionsClient | null>(null)

/**
 * A mutable client holder the router publishes so route loaders (which run above
 * the provider in the tree) can reach the client once `<RabbatProvider>` creates it.
 */
export interface ClientHolder {
  client: FunctionsClient | null
}
export const ClientHolderContext = createContext<ClientHolder | null>(null)

export interface RabbatProviderProps {
  /** Provide a client explicitly, or omit to auto-create one (same-origin `/ws`). */
  readonly client?: FunctionsClient
  readonly options?: Partial<FunctionsClientOptions>
  readonly token?: string | null
  readonly children: ReactNode
}

function defaultClient(options?: Partial<FunctionsClientOptions>): FunctionsClient {
  const url =
    options?.url ??
    (typeof location !== "undefined" ? `${location.origin.replace(/^http/, "ws")}/ws` : "ws://localhost/ws")
  return new FunctionsClient({ persist: true, ...options, url })
}

/**
 * Provides the FunctionsClient to the tree and opens the connection in the
 * browser (on the server it stays seeded from preloads and never connects).
 * Omit `client` to auto-create one — the generated router entry mounts this in
 * the root layout, so an app never writes `main.tsx`.
 */
export function RabbatProvider({ client, options, token, children }: RabbatProviderProps) {
  const [instance] = useState<FunctionsClient>(() => client ?? defaultClient(options))
  const holder = useContext(ClientHolderContext)
  if (holder) holder.client = instance // publish to the router for loader preloads

  useEffect(() => {
    if (token !== undefined) instance.setAuth(token)
    instance.connect()
    return () => instance.close()
  }, [instance, token])

  return createElement(ClientContext.Provider, { value: instance }, children)
}

export function useRabbat(): FunctionsClient {
  const client = useContext(ClientContext)
  if (!client) throw new Error("useRabbat must be used within a <RabbatProvider>")
  return client
}

export function useConnectionStatus(): ConnectionStatus {
  const client = useRabbat()
  const [status, setStatus] = useState<ConnectionStatus>(() => client.getStatus())
  useEffect(() => {
    const unsubscribe = client.onStatusChange(setStatus)
    // Re-sync inside the effect: the status may have changed between the initial
    // render (useState initializer) and this subscription (e.g. connect() firing
    // in the provider effect), and that transition would otherwise be missed.
    setStatus(client.getStatus())
    return unsubscribe
  }, [client])
  return status
}
