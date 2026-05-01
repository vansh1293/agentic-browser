import { useState, useEffect, useRef } from "react";
import { Mic, MicOff, X, Volume2 } from "lucide-react";

interface VoiceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface VoiceConversationProps {
  isOpen: boolean;
  onClose: () => void;
  baseUrl?: string;
}

type PipelineState = "idle" | "recording" | "processing" | "speaking";

// ── Audio playback queue ──────────────────────────────────────────────────────

class AudioQueue {
  private ctx: AudioContext;
  private queue: ArrayBuffer[] = [];
  private playing = false;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 44100 });
  }

  enqueue(pcmBuffer: ArrayBuffer) {
    this.queue.push(pcmBuffer);
    if (!this.playing) this._drain();
  }

  private async _drain() {
    if (this.queue.length === 0) { this.playing = false; return; }
    this.playing = true;
    const buf = this.queue.shift()!;
    const float32 = new Float32Array(buf);
    const audioBuf = this.ctx.createBuffer(1, float32.length, 44100);
    audioBuf.copyToChannel(float32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(this.ctx.destination);
    src.onended = () => this._drain();
    src.start();
  }

  stop() {
    this.queue = [];
    this.playing = false;
    try { this.ctx.close(); } catch (_) { /* ignore */ }
  }
}

// ── Waveform bars ─────────────────────────────────────────────────────────────

function WaveBars({ active, count = 20 }: { active: boolean; count?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, height: 48 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          width: 3, borderRadius: 4,
          background: active ? `hsl(${250 + i * 4}, 80%, 65%)` : "var(--border-color)",
          height: active ? `${20 + Math.sin(i * 0.8) * 14}px` : "6px",
          animation: active ? `voiceBar 1.1s ease-in-out infinite` : "none",
          animationDelay: `${i * 0.05}s`,
          transition: "height 0.3s ease",
        }} />
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function VoiceConversation({ isOpen, onClose, baseUrl }: VoiceConversationProps) {
  const [state, setState] = useState<PipelineState>("idle");
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [assistantLive, setAssistantLive] = useState("");
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioQueueRef = useRef<AudioQueue | null>(null);
  const userMsgIdRef = useRef<string>("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const getWsBase = () =>
    (baseUrl || localStorage.getItem("baseUrl") || "http://localhost:5454")
      .replace(/^http/, "ws");

  function matchPrefix(bytes: Uint8Array, prefix: string) {
    const enc = new TextEncoder().encode(prefix);
    return bytes.length >= enc.length && enc.every((b, i) => bytes[i] === b);
  }

  // ── Run full pipeline via WebSocket ────────────────────────────────────────

  const runPipeline = (audioBlob: Blob, history: VoiceMessage[]) => {
    wsRef.current?.close();
    const ws = new WebSocket(`${getWsBase()}/api/voice/ws`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const decoder = new TextDecoder();
    let firstTextReceived = false;
    let assistantText = "";

    ws.onopen = () => {
      // Send history then audio
      ws.send(JSON.stringify({ history: history.map(m => ({ role: m.role, content: m.text })) }));
      audioBlob.arrayBuffer().then(ab => ws.send(ab));
    };

    ws.onmessage = (evt) => {
      const bytes = new Uint8Array(evt.data as ArrayBuffer);

      if (matchPrefix(bytes, "TEXT:")) {
        const text = decoder.decode(bytes.slice(5));

        if (!firstTextReceived) {
          // First TEXT frame is the STT transcript — update user bubble
          firstTextReceived = true;
          setMessages(prev => prev.map(m =>
            m.id === userMsgIdRef.current ? { ...m, text } : m
          ));
        } else {
          // Subsequent TEXT frames are LLM response tokens
          assistantText += text + " ";
          setAssistantLive(assistantText);
        }

      } else if (matchPrefix(bytes, "AUDIO:")) {
        const len = new DataView(evt.data as ArrayBuffer, 6, 4).getUint32(0, false);
        const pcm = (evt.data as ArrayBuffer).slice(10, 10 + len);
        setState("speaking");
        audioQueueRef.current?.enqueue(pcm);

      } else if (matchPrefix(bytes, "DONE")) {
        setState("idle");
        // Commit assistant live text as a real message
        if (assistantText.trim()) {
          setMessages(prev => [
            ...prev,
            { id: Date.now().toString(), role: "assistant", text: assistantText.trim() },
          ]);
        }
        setAssistantLive("");

      } else if (matchPrefix(bytes, "ERR:")) {
        setError(decoder.decode(bytes.slice(4)));
        setState("idle");
      }
    };

    ws.onerror = () => {
      setError("Could not connect to voice backend. Is the server running?");
      setState("idle");
    };

    ws.onclose = () => { wsRef.current = null; };
  };

  // ── Recording ──────────────────────────────────────────────────────────────

  const startRecording = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioQueueRef.current?.stop();
      audioQueueRef.current = new AudioQueue();

      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        if (blob.size === 0) { setState("idle"); return; }

        // Add user bubble with "…" placeholder — will be updated to transcript
        const uid = Date.now().toString();
        userMsgIdRef.current = uid;
        setMessages(prev => [...prev, { id: uid, role: "user", text: "…" }]);
        setState("processing");
        runPipeline(blob, messages);
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setState("recording");
    } catch (e: any) {
      setError(e.message || "Microphone access denied");
    }
  };

  const stopRecording = () => { mediaRecorderRef.current?.stop(); };

  const toggleMic = () => {
    if (state === "recording") stopRecording();
    else if (state === "idle") startRecording();
  };

  // ── Cleanup on close ───────────────────────────────────────────────────────

  useEffect(() => {
    if (!isOpen) {
      wsRef.current?.close();
      audioQueueRef.current?.stop();
      mediaRecorderRef.current?.stop();
      setState("idle");
      setAssistantLive("");
    }
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, assistantLive]);

  if (!isOpen) return null;

  const micActive = state === "recording";
  const busy = state === "processing" || state === "speaking";

  return (
    <>
      <style>{`
        @keyframes voiceBar {
          0%, 100% { transform: scaleY(1); }
          50%       { transform: scaleY(1.8); }
        }
        @keyframes pulseMic {
          0%   { box-shadow: 0 0 0 0   rgba(139,92,246,0.6); }
          70%  { box-shadow: 0 0 0 22px rgba(139,92,246,0);   }
          100% { box-shadow: 0 0 0 0   rgba(139,92,246,0);   }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0);    }
        }
      `}</style>

      <div style={{
        position: "fixed", inset: 0, zIndex: 20000,
        background: "var(--bg-color)",
        display: "flex", flexDirection: "column",
        animation: "fadeUp 0.25s ease",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 18px",
          borderBottom: "1px solid var(--border-color)",
          background: "var(--bg-2)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Volume2 size={18} style={{ color: "#a78bfa" }} />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Voice Conversation</span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}>
            <X size={22} />
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && state === "idle" && (
            <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: 80 }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🎙️</div>
              <p style={{ fontSize: 14, fontWeight: 600 }}>Tap the mic and start talking</p>
              <p style={{ fontSize: 12, marginTop: 6, opacity: 0.5 }}>Whisper · Gemini · Cartesia</p>
            </div>
          )}

          {messages.map(m => (
            <div key={m.id} style={{
              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
              background: m.role === "user"
                ? "linear-gradient(135deg,#6d28d9,#8b5cf6)"
                : "var(--input-bg)",
              color: m.role === "user" ? "#fff" : "var(--text-primary)",
              borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
              padding: "10px 14px", maxWidth: "80%", fontSize: 13, lineHeight: 1.5,
            }}>
              {m.text}
            </div>
          ))}

          {/* Live assistant response */}
          {assistantLive && (
            <div style={{
              alignSelf: "flex-start", background: "var(--input-bg)",
              color: "var(--text-primary)",
              borderRadius: "18px 18px 18px 4px",
              padding: "10px 14px", maxWidth: "80%", fontSize: 13, lineHeight: 1.5,
              opacity: 0.85, fontStyle: "italic",
            }}>
              {assistantLive}
              <span style={{
                display: "inline-block", width: 6, height: 6, borderRadius: "50%",
                background: "#a78bfa", marginLeft: 6, animation: "pulseMic 1s infinite",
              }} />
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Status */}
        <div style={{ padding: "8px 16px", textAlign: "center", minHeight: 56 }}>
          {state === "recording" && <WaveBars active={true} />}
          {state === "processing" && <p style={{ fontSize: 12, color: "var(--text-muted)" }}>Transcribing & thinking…</p>}
          {state === "speaking" && (
            <div>
              <WaveBars active={true} count={14} />
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Speaking…</p>
            </div>
          )}
          {error && <p style={{ fontSize: 12, color: "#dc2626" }}>{error}</p>}
        </div>

        {/* Mic button */}
        <div style={{ padding: "16px 0 28px", display: "flex", justifyContent: "center" }}>
          <button
            onClick={toggleMic}
            disabled={busy}
            style={{
              width: 76, height: 76, borderRadius: "50%", border: "none",
              cursor: busy ? "not-allowed" : "pointer",
              background: micActive
                ? "linear-gradient(135deg,#7c3aed,#a855f7)"
                : busy ? "var(--input-bg)"
                : "linear-gradient(135deg,#6d28d9,#8b5cf6)",
              color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: micActive ? "none" : "0 4px 24px rgba(109,40,217,0.45)",
              animation: micActive ? "pulseMic 1.2s ease-out infinite" : "none",
              transition: "transform 0.15s, background 0.2s",
              transform: micActive ? "scale(1.1)" : "scale(1)",
              opacity: busy ? 0.4 : 1,
            }}
          >
            {micActive ? <MicOff size={32} /> : <Mic size={32} />}
          </button>
        </div>

        <p style={{ textAlign: "center", fontSize: 11, color: "var(--text-muted)", marginBottom: 20 }}>
          {micActive ? "Tap again to send" : busy ? "" : "Tap to talk"}
        </p>
      </div>
    </>
  );
}
