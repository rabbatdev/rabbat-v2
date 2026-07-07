import { useState, type FormEvent } from "react"
import { Outlet, RabbatProvider, useMutation, useQuery } from "@rabbat/react"
import { api } from "../_generated/api.js"
import { Link, useNavigate } from "../_generated/routes.js"
import { ConnectionBadge } from "../../src/components/ConnectionBadge.js"

interface Channel {
  id: string
  name: string
  created_at: number
}

/**
 * The root layout. The providers live here — the user never writes main.tsx;
 * the generated entry mounts the router, which renders this layout (and its
 * `<Outlet/>`) around every page.
 */
export default function RootLayout() {
  return (
    <RabbatProvider>
      <Shell />
    </RabbatProvider>
  )
}

function Shell() {
  const channels = useQuery(api.channels.list, {}) as Channel[] | undefined
  const createChannel = useMutation(api.channels.create)
  const navigate = useNavigate()

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          🐇 Rabbat <ConnectionBadge />
        </div>
        <div className="channels">
          {(channels ?? []).map((c) => (
            <Link key={c.id} to="/channels/:channelId" params={{ channelId: c.id }} className="channel">
              # {c.name}
            </Link>
          ))}
        </div>
        <NewChannel
          onCreate={(name) => createChannel({ name }).then((r) => navigate("/channels/:channelId", { params: { channelId: r.id } }))}
        />
      </aside>
      <main className="main">
        <Outlet />
      </main>
    </div>
  )
}

function NewChannel({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState("")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (n) {
      onCreate(n)
      setName("")
    }
  }
  return (
    <form className="new" onSubmit={submit}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="+ new channel" />
    </form>
  )
}
