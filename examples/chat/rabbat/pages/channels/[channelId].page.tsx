import { useEffect, useRef, useState, type FormEvent } from "react"
import { usePaginatedQuery, useMutation } from "@rabbat/react"
import { api } from "../../_generated/api.js"
import { route } from "./[channelId].route.js"

export default function ChannelPage() {
  // Typed from the path — `channelId: string`, no schema.
  const { channelId } = route.useParams()
  const { data, status, hasOlder, loadOlder } = usePaginatedQuery(
    api.messages.list,
    { channelId },
    { initialNumItems: 30 },
  )
  const send = useMutation(api.messages.send)
  const [who, setWho] = useState("guest")
  const [body, setBody] = useState("")
  const feedRef = useRef<HTMLDivElement>(null)

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
          <div className="msg" key={m.id as string}>
            <span className="who">{m.author as string}</span>
            <span>{m.body as string}</span>
            <span className="when">{new Date(m.created_at as number).toLocaleTimeString()}</span>
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
