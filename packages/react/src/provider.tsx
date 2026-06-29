import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react"
import type { ConnectionStatus, FunctionsClient } from "@rabbat/client"

const ClientContext = createContext<FunctionsClient | null>(null)

export interface RabbatProviderProps {
  readonly client: FunctionsClient
  readonly children: ReactNode
}

/**
 * Provides the FunctionsClient to the tree and opens the connection in the
 * browser (on the server it stays seeded from preloads and never connects).
 */
export function RabbatProvider({ client, children }: RabbatProviderProps) {
  useEffect(() => {
    client.connect()
    return () => client.close()
  }, [client])
  return createElement(ClientContext.Provider, { value: client }, children)
}

export function useRabbat(): FunctionsClient {
  const client = useContext(ClientContext)
  if (!client) throw new Error("useRabbat must be used within a <RabbatProvider>")
  return client
}

export function useConnectionStatus(): ConnectionStatus {
  const client = useRabbat()
  const [status, setStatus] = useState<ConnectionStatus>(() => client.getStatus())
  useEffect(() => client.onStatusChange(setStatus), [client])
  return status
}
