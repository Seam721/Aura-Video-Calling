import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createClient, User } from "@supabase/supabase-js";

type ChatMessage = { id: string; userId: string; name: string; text: string; time: string };
type Signal = { from: string; to?: string; kind: "join" | "offer" | "answer" | "ice" | "leave" | "chat"; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; message?: ChatMessage };
type Peer = { id: string; name: string; stream: MediaStream };
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const supabase = url && key ? createClient(url, key) : null;
const ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

function VideoTile({ stream, name, muted = false }: { stream: MediaStream; name: string; muted?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (video.current) { video.current.srcObject = stream; void video.current.play().catch(() => {}); } }, [stream]);
  return <article className="video-tile"><video ref={video} autoPlay playsInline muted={muted}/><span className="video-name">{name}</span></article>;
}
function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!supabase);
  const [authMode, setAuthMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [displayName, setDisplayName] = useState("");
  const [authError, setAuthError] = useState(""); const [error, setError] = useState("");
  const [roomInput, setRoomInput] = useState(new URLSearchParams(location.search).get("room") || "");
  const [roomId, setRoomId] = useState(""); const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState("Ready"); const [elapsed, setElapsed] = useState(0);
  const [micOn, setMicOn] = useState(true); const [cameraOn, setCameraOn] = useState(true); const [sharing, setSharing] = useState(false);
  const [panel, setPanel] = useState<"chat" | "people" | null>("people");
  const [peers, setPeers] = useState<Peer[]>([]); const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const local = useRef<MediaStream | null>(null); const screen = useRef<MediaStream | null>(null);
  const channel = useRef<ReturnType<NonNullable<typeof supabase>["channel"]> | null>(null);
  const connections = useRef(new Map<string, RTCPeerConnection>());
  const pendingIce = useRef(new Map<string, RTCIceCandidateInit[]>());
  const names = useRef(new Map<string, string>());
  const myName = displayName.trim() || user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Guest";
  const myId = user?.id || "";

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => { setUser(data.session?.user ?? null); setAuthReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => { if (!joined) return; const t = window.setInterval(() => setElapsed(v => v + 1), 1000); return () => clearInterval(t); }, [joined]);

  const signal = useCallback(async (payload: Omit<Signal, "from">) => {
    if (channel.current) await channel.current.send({ type: "broadcast", event: "signal", payload: { ...payload, from: myId } });
  }, [myId]);

  const makePeer = useCallback((id: string, peerName: string) => {
    const old = connections.current.get(id); if (old) return old;
    const pc = new RTCPeerConnection({ iceServers: ICE }); connections.current.set(id, pc); names.current.set(id, peerName);
    local.current?.getTracks().forEach(track => pc.addTrack(track, local.current!));
    pc.onicecandidate = e => { if (e.candidate) void signal({ to: id, kind: "ice", candidate: e.candidate.toJSON() }); };
    pc.ontrack = e => { const stream = e.streams[0] || new MediaStream([e.track]); setPeers(p => [...p.filter(x => x.id !== id), { id, name: names.current.get(id) || "Participant", stream }]); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "connected") setStatus("Connected"); else if (pc.connectionState === "failed") { pc.restartIce(); setStatus("Reconnecting…"); } };
    return pc;
  }, [signal]);

  const leave = useCallback(async () => {
    await signal({ kind: "leave" }).catch(() => {});
    channel.current?.unsubscribe(); channel.current = null;
    connections.current.forEach(pc => pc.close()); connections.current.clear(); pendingIce.current.clear(); names.current.clear();
    local.current?.getTracks().forEach(t => t.stop()); local.current = null;
    screen.current?.getTracks().forEach(t => t.stop()); screen.current = null;
    setPeers([]); setJoined(false); setRoomId(""); setElapsed(0); setSharing(false); setStatus("Ready");
    history.replaceState({}, "", location.pathname);
  }, [signal]);

  const join = async (id: string) => {
    if (!supabase || !user) { setError("Configure Supabase and sign in first."); return; }
    if (!id.trim()) return;
    setError(""); setStatus("Requesting camera and microphone…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      local.current = stream; setRoomId(id); setJoined(true);
      const ch = supabase.channel(`aura-room-${id}`, { config: { private: true, broadcast: { self: false } } }); channel.current = ch;
      ch.on("broadcast", { event: "signal" }, async ({ payload }) => {
        const s = payload as Signal;
        if (!s || s.from === myId || (s.to && s.to !== myId)) return;
        try {
          if (s.kind === "join") {
            const n = s.message?.name || "Participant"; names.current.set(s.from, n);
            const pc = makePeer(s.from, n);
            if (pc.signalingState === "stable") { const offer = await pc.createOffer(); await pc.setLocalDescription(offer); await signal({ to: s.from, kind: "offer", description: offer }); }
          } else if (s.kind === "offer" && s.description) {
            const pc = makePeer(s.from, s.message?.name || "Participant"); await pc.setRemoteDescription(s.description);
            for (const c of pendingIce.current.get(s.from) || []) await pc.addIceCandidate(c); pendingIce.current.delete(s.from);
            const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); await signal({ to: s.from, kind: "answer", description: answer });
          } else if (s.kind === "answer" && s.description) {
            const pc = connections.current.get(s.from); if (pc) { await pc.setRemoteDescription(s.description); for (const c of pendingIce.current.get(s.from) || []) await pc.addIceCandidate(c); pendingIce.current.delete(s.from); }
          } else if (s.kind === "ice" && s.candidate) {
            const pc = connections.current.get(s.from);
            if (pc?.remoteDescription) await pc.addIceCandidate(s.candidate);
            else pendingIce.current.set(s.from, [...(pendingIce.current.get(s.from) || []), s.candidate]);
          } else if (s.kind === "leave") {
            connections.current.get(s.from)?.close(); connections.current.delete(s.from); names.current.delete(s.from); setPeers(p => p.filter(x => x.id !== s.from));
          } else if (s.kind === "chat" && s.message) setMessages(p => [...p, s.message!]);
        } catch (e) { console.error("WebRTC signaling error", e); }
      });
      const subscription = await new Promise<{ ok: true } | { ok: false; reason: string }>(resolve => {
        let settled = false;
        const finish = (result: { ok: true } | { ok: false; reason: string }) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeout);
          resolve(result);
        };
        const timeout = window.setTimeout(() => finish({
          ok: false,
          reason: "The Realtime server did not confirm the room subscription within 15 seconds. Check that Realtime is enabled and that the realtime.messages policies allow authenticated users to access aura-room-* topics.",
        }), 15000);
        ch.subscribe((state, err) => {
          if (state === "SUBSCRIBED") finish({ ok: true });
          else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
            const detail = err instanceof Error ? err.message : (err ? String(err) : "No additional details from Supabase.");
            console.error("Aura Realtime subscription failed:", state, err);
            finish({ ok: false, reason: `Supabase Realtime subscription failed (${state}). ${detail} Check Realtime is enabled and run the SQL in supabase/realtime-policies.sql.` });
          }
        });
      });
      if (!subscription.ok) throw new Error(subscription.reason);
      await signal({ kind: "join", message: { id: crypto.randomUUID(), userId: myId, name: myName, text: "", time: "" } });
      setStatus("Waiting for participants"); history.replaceState({}, "", `${location.pathname}?room=${encodeURIComponent(id)}`);
    } catch (e) {
      await leave(); setError(e instanceof Error ? e.message : "Could not access camera or microphone. Allow browser permissions."); setStatus("Connection failed");
    }
  };

  const signIn = async (e: FormEvent) => {
    e.preventDefault(); if (!supabase) return; setAuthError("");
    const result = authMode === "login"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { data: { full_name: displayName || email.split("@")[0] } } });
    if (result.error) setAuthError(result.error.message);
    else if (authMode === "signup" && !result.data.session) setAuthError("Account created. Confirm your email, then sign in.");
  };
  const toggleMic = () => { const on = !micOn; local.current?.getAudioTracks().forEach(t => t.enabled = on); setMicOn(on); };
  const toggleCamera = () => { const on = !cameraOn; local.current?.getVideoTracks().forEach(t => t.enabled = on); setCameraOn(on); };
  const toggleShare = async () => {
    if (sharing) { const track = local.current?.getVideoTracks()[0]; if (track) connections.current.forEach(pc => { const sender = pc.getSenders().find(s => s.track?.kind === "video"); if (sender) void sender.replaceTrack(track); }); screen.current?.getTracks().forEach(t => t.stop()); screen.current = null; setSharing(false); return; }
    try { const s = await navigator.mediaDevices.getDisplayMedia({ video: true }); screen.current = s; const track = s.getVideoTracks()[0]; connections.current.forEach(pc => { const sender = pc.getSenders().find(x => x.track?.kind === "video"); if (sender) void sender.replaceTrack(track); }); track.onended = () => { const cameraTrack = local.current?.getVideoTracks()[0]; if (cameraTrack) connections.current.forEach(pc => { const sender = pc.getSenders().find(x => x.track?.kind === "video"); if (sender) void sender.replaceTrack(cameraTrack); }); setSharing(false); }; setSharing(true); }
    catch { setError("Screen sharing was cancelled or is unavailable."); }
  };
  const sendChat = (e: FormEvent) => { e.preventDefault(); const text = draft.trim(); if (!text) return; const message = { id: crypto.randomUUID(), userId: myId, name: myName, text, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }; setMessages(p => [...p, message]); void signal({ kind: "chat", message }); setDraft(""); };
  const invite = `${location.origin}${location.pathname}?room=${roomId}`;
  const time = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;

  if (!authReady) return <main className="setup-screen">Loading…</main>;
  if (!supabase) return <main className="setup-screen"><div className="setup-card"><div className="brand-mark">✦</div><p className="eyebrow">AURA VIDEO</p><h1>Connect Supabase</h1><p>Copy <code>.env.example</code> to <code>.env</code> and add your project URL and anon key.</p><code>VITE_SUPABASE_URL=https://your-project.supabase.co<br/>VITE_SUPABASE_ANON_KEY=your-anon-key</code></div></main>;
  if (!user) return <main className="setup-screen"><form className="setup-card auth-card" onSubmit={signIn}><div className="brand-mark">✦</div><p className="eyebrow">AURA VIDEO</p><h1>{authMode === "login" ? "Welcome back" : "Create your account"}</h1><p>Sign in to create and join live meetings.</p>{authMode === "signup" && <input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Your name"/>}<input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="Email address"/><input type="password" minLength={6} required value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"/><button className="primary-action">{authMode === "login" ? "Sign in" : "Create account"}</button>{authError && <p className="error-text">{authError}</p>}<button type="button" className="text-action" onClick={() => setAuthMode(authMode === "login" ? "signup" : "login")}>{authMode === "login" ? "New here? Create an account" : "Already registered? Sign in"}</button></form></main>;
  if (!joined) return <main className="setup-screen"><div className="setup-card"><div className="brand-mark">✦</div><p className="eyebrow">AURA VIDEO</p><h1>Video calls, made simple.</h1><p>Start a room or join someone using their meeting code.</p><button className="primary-action" onClick={() => { const id = Math.random().toString(36).slice(2, 8).toUpperCase(); setRoomInput(id); void join(id); }}>＋ Create a new meeting</button><div className="join-divider"><span>or join a meeting</span></div><form className="join-form" onSubmit={e => { e.preventDefault(); void join(roomInput.trim().toUpperCase()); }}><input value={roomInput} onChange={e => setRoomInput(e.target.value.toUpperCase())} placeholder="Enter meeting code" required/><button>Join</button></form>{error && <p className="error-text">{error}</p>}<button className="text-action" onClick={() => supabase.auth.signOut()}>Sign out ({user.email})</button><p className="fine-print">Camera and microphone permission are required.</p></div></main>;

  return <main className="app-shell"><header className="topbar"><div className="brand"><div className="brand-mark">✦</div><span>Aura</span></div><div className="meeting-title"><strong>Meeting {roomId}</strong><span><i/> {status} · {time}</span></div><div className="top-actions"><button className="invite-button" onClick={() => void navigator.clipboard.writeText(invite)}>Copy invite link</button><button className="profile-button" title={myName}>{myName.slice(0, 2).toUpperCase()}</button></div></header>
  <section className="workspace"><div className="call-stage"><div className="video-grid live-grid"><VideoTile stream={local.current!} muted name={`${myName} (You)`}/>{peers.map(p => <VideoTile key={p.id} stream={p.stream} name={p.name}/>)}</div><div className="controls-wrap"><div className="controls"><button className={`control-button ${!micOn ? "off" : ""}`} onClick={toggleMic} title="Microphone">{micOn ? "🎙" : "🔇"}</button><button className={`control-button ${!cameraOn ? "off" : ""}`} onClick={toggleCamera} title="Camera">{cameraOn ? "▣" : "▧"}</button><button className={`control-button ${sharing ? "active" : ""}`} onClick={() => void toggleShare()} title="Share screen">▱</button><button className="control-button" onClick={() => setPanel(panel === "people" ? null : "people")}>♙</button><button className="control-button" onClick={() => setPanel(panel === "chat" ? null : "chat")}>▤</button><button className="end-button" onClick={() => void leave()} title="Leave call">☎</button></div></div></div>
  {panel && <aside className="side-panel"><div className="panel-header"><div className="panel-tabs"><button className={panel === "chat" ? "selected" : ""} onClick={() => setPanel("chat")}>Chat</button><button className={panel === "people" ? "selected" : ""} onClick={() => setPanel("people")}>People ({peers.length + 1})</button></div><button className="panel-close" onClick={() => setPanel(null)}>×</button></div>{panel === "chat" ? <><div className="chat-list">{messages.map(m => <div className={`chat-message ${m.userId === myId ? "own" : ""}`} key={m.id}><div className="message-meta"><strong>{m.name}</strong><span>{m.time}</span></div><p>{m.text}</p></div>)}</div><form className="chat-form" onSubmit={sendChat}><input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Message everyone"/><button disabled={!draft.trim()}>➤</button></form></> : <div className="people-list"><div className="person-row"><div className="mini-avatar">{myName.slice(0, 2).toUpperCase()}</div><div><strong>{myName} (You)</strong><span>In this meeting</span></div></div>{peers.map(p => <div className="person-row" key={p.id}><div className="mini-avatar">{p.name.slice(0, 2).toUpperCase()}</div><div><strong>{p.name}</strong><span>Connected</span></div></div>)}</div>}</aside>}</section>{error && <div className="toast-error">{error}<button onClick={() => setError("")}>×</button></div>}</main>;
}
export default App;
