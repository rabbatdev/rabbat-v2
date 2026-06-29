import { useEffect, useRef, useState, type FormEvent } from "react"
import { useConnectionStatus, useMutation, usePaginatedQuery, useQuery } from "@rabbat/react"
import { api } from "../rabbat/_generated/api.js"

interface Channel {
  id: string
  name: string
  created_at: number
}

export default function App() {
  const status = useConnectionStatus()
  const channels = useQuery(api.channels.list, {}) as Channel[] | undefined
  const createChannel = useMutation(api.channels.create)

  const [selected, setSelected] = useState<string | null>(null)
  const channelId = selected ?? channels?.[0]?.id ?? null

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          🐇 Rabbat <span className={`dot ${status}`} title={status} />
        </div>
        <div className="channels">
          {(channels ?? []).map((c) => (
            <div
              key={c.id}
              className={`channel ${c.id === channelId ? "active" : ""}`}
              onClick={() => setSelected(c.id)}
            >
              # {c.name}
            </div>
          ))}
        </div>
        <NewChannel onCreate={(name) => createChannel({ name }).then((r) => setSelected(r.id))} />
      </aside>
      <main className="main">
        {channelId ? <Channel channelId={channelId} /> : <div className="empty">Create a channel to begin</div>}
      </main>
    </div>
  )
}

function NewChannel({ onCreate }: { onCreate: (name: string) => void }) {
  const [name, setName] = useState("")
  return (
    <form
      className="new"
      onSubmit={(e) => {
        e.preventDefault()
        const n = name.trim()
        if (n) {
          onCreate(n)
          setName("")
        }
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="+ new channel" />
    </form>
  )
}

function Channel({ channelId }: { channelId: string }) {
  const { data, status, hasOlder, loadOlder } = usePaginatedQuery(
    api.messages.list,
    { channelId },
    { initialNumItems: 30 },
  )
  const send = useMutation(api.messages.send)
  const [who, setWho] = useState("guest")
  const [body, setBody] = useState("")
  const feedRef = useRef<HTMLDivElement>(null)

  // Stick to the bottom as new messages stream in.
  useEffect(() => {
    const el = feedRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [data.length])

  const onSend = (e: FormEvent) => {
    e.preventDefault()
    if (!body.trim()) return
    void send({ channelId, author: who || "guest", body })
    setBody("")
  }

  return (
    <>
      <div className="feed" ref={feedRef}>
        {hasOlder && (
          <button className="more" onClick={loadOlder}>
            ↑ load older
          </button>
        )}
        {status === "loading" && data.length === 0 && <div className="empty">Loading…</div>}
        {data.map((m) => (
          <div className="msg" key={m.id}>
            <span className="who">{m.author}</span>
            <span>{m.body}</span>
            <span className="when">{new Date(m.created_at).toLocaleTimeString()}</span>
          </div>
        ))}
      </div>
      <form className="composer" onSubmit={onSend}>
        <input className="who-input" value={who} onChange={(e) => setWho(e.target.value)} placeholder="name" />
        <input value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message — open two tabs to watch it sync" autoFocus />
        <button className="send" type="submit">
          Send
        </button>
      </form>
    </>
  )
}
