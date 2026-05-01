/**
 * VoiceConversation.tsx
 *
 * Full voice-agent UI:
 *   1. Record mic → POST to /api/voice/transcribe (Whisper STT)
 *   2. Transcript → executeAgent() (same pipeline as chat: browser tools, Gmail, etc.)
 *   3. Agent final answer → POST to /api/voice/speak (Cartesia TTS, markdown stripped)
 *   4. Stream PCM audio chunks → AudioContext playback
 *   5. Barge-in: mic energy detector stops playback when user starts speaking
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Mic, MicOff, X, Volume2, Loader2, Zap } from "lucide-react";
import { executeAgent, AgentStreamEvent } from "../../utils/executeAgent";
import { executeBrowserActions } from "../../utils/executeActions";

// ── Types ─────────────────────────────────────────────────────────────────────

interface VoiceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  agentEvents?: string[];
}

interface VoiceConversationProps {
  isOpen: boolean;
  onClose: () => void;
}

type PipelineState = "idle" | "recording" | "transcribing" | "thinking" | "speaking";

// ── Audio streaming player (barge-in capable) ─────────────────────────────────

class StreamPlayer {
  private ctx: AudioContext;
  private gainNode: GainNode;
  private queue: Float32Array[] = [];
  private playing = false;
  public onBargein?: () => void;

  // Barge-in: mic energy analyser
  private bargeInStream?: MediaStream;
  private bargeInAnalyser?: AnalyserNode;
  private bargeInFrame?: number;
  private BARGE_THRESHOLD = 0.015;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 44100 });
    this.gainNode = this.ctx.createGain();
    this.gainNode.connect(this.ctx.destination);
  }

  enqueue(float32: Float32Array) {
    this.queue.push(float32);
    if (!this.playing) this._drain();
  }

  private async _drain() {
    if (this.queue.length === 0) { this.playing = false; return; }
    this.playing = true;
    const samples = this.queue.shift()!;
    const buf = this.ctx.createBuffer(1, samples.length, 44100);
    buf.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gainNode);
    src.onended = () => this._drain();
    src.start();
  }

  async startBargeIn() {
    try {
      this.bargeInStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const src = this.ctx.createMediaStreamSource(this.bargeInStream);
      this.bargeInAnalyser = this.ctx.createAnalyser();
      this.bargeInAnalyser.fftSize = 512;
      src.connect(this.bargeInAnalyser);
      this._checkBarge();
    } catch (_) { /* no barge-in if mic not available */ }
  }

  private _checkBarge() {
    if (!this.bargeInAnalyser) return;
    const data = new Float32Array(this.bargeInAnalyser.fftSize);
    this.bargeInAnalyser.getFloatTimeDomainData(data);
    const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
    if (rms > this.BARGE_THRESHOLD && this.playing) {
      this.stop();
      this.onBargein?.();
      return;
    }
    this.bargeInFrame = requestAnimationFrame(() => this._checkBarge());
  }

  stop() {
    this.queue = [];
    this.playing = false;
    try { this.gainNode.gain.setValueAtTime(0, this.ctx.currentTime); } catch (_) {}
    this.stopBarge();
    // Reset gain for next time
    setTimeout(() => {
      try { this.gainNode.gain.setValueAtTime(1, this.ctx.currentTime); } catch (_) {}
    }, 100);
  }

  stopBarge() {
    if (this.bargeInFrame) cancelAnimationFrame(this.bargeInFrame);
    this.bargeInStream?.getTracks().forEach(t => t.stop());
    this.bargeInStream = undefined;
    this.bargeInAnalyser = undefined;
  }

  dispose() {
    this.stop();
    try { this.ctx.close(); } catch (_) {}
  }
}

// ── Waveform bars ─────────────────────────────────────────────────────────────

function WaveBars({ active, count = 18, color = "#a78bfa" }: { active: boolean; count?: number; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, height: 40 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          width: 3, borderRadius: 4, background: active ? color : "var(--border-color)",
          height: active ? `${16 + Math.sin(i * 0.9) * 12}px` : "5px",
          animation: active ? `voiceBar 1.1s ease-in-out infinite` : "none",
          animationDelay: `${i * 0.055}s`,
          transition: "height 0.25s ease",
        }} />
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function VoiceConversation({ isOpen, onClose }: VoiceConversationProps) {
  const [pipelineState, setPipelineState] = useState<PipelineState>("idle");
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const [agentStatus, setAgentStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

  const playerRef = useRef<StreamPlayer | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const getBase = () =>
    (localStorage.getItem("baseUrl") || import.meta.env.VITE_API_URL || "http://localhost:5454").replace(/\/$/, "");

  // ── Step 1: STT ─────────────────────────────────────────────────────────────

  const transcribeAudio = async (blob: Blob): Promise<string> => {
    const base = getBase();
    const fd = new FormData();
    fd.append("file", blob, "recording.webm");
    const res = await fetch(`${base}/api/voice/transcribe`, { method: "POST", body: fd });
    if (!res.ok) throw new Error(`STT failed: ${res.status}`);
    const data = await res.json();
    return data.text?.trim() || "";
  };

  // ── Step 2: Agent execution ─────────────────────────────────────────────────

  const runAgent = async (transcript: string, msgId: string): Promise<string> => {
    const base = getBase();
    const command = `/react-ask ${transcript}`;
    let finalAnswer = "";
    let streamedAnswer = "";

    const onEvent = async (evt: AgentStreamEvent) => {
      const d = evt.data || {};
      switch (evt.event) {
        case "supervisor_iteration":
          setAgentStatus(`Thinking… loop ${d.iteration ?? ""}`);
          break;
        case "subagent_started":
          setAgentStatus(`Running ${d.subagent || "agent"}…`);
          addAgentEvent(msgId, `${d.subagent} started`);
          break;
        case "subagent_tool_call":
          setAgentStatus(`${d.subagent} → ${d.tool}`);
          addAgentEvent(msgId, `${d.subagent} → ${d.tool}`);
          break;
        case "subagent_tool_result":
          if (d.tool === "browser_action_agent") {
            const ap = d?.result?.action_plan || d?.result?.result?.action_plan || d?.result;
            if (ap?.actions) await executeBrowserActions(ap.actions);
          }
          break;
        case "answer_delta":
          if (typeof d.delta === "string") {
            streamedAnswer += d.delta;
            finalAnswer = streamedAnswer;
          }
          break;
        case "final":
          finalAnswer = d.answer || streamedAnswer;
          setAgentStatus("");
          break;
        case "automation_started":
          setAgentStatus("Browser automation…");
          break;
      }
    };

    // history for context
    const history = messages.map(m => ({ id: m.id, role: m.role, content: m.text, timestamp: new Date().toISOString() }));

    await executeAgent(command, transcript, history as any, undefined, onEvent, undefined);
    return finalAnswer || "Done.";
  };

  const addAgentEvent = (msgId: string, label: string) => {
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, agentEvents: [...(m.agentEvents || []), label] } : m
    ));
  };

  // ── Step 3: TTS ─────────────────────────────────────────────────────────────

  const speakText = async (text: string) => {
    const base = getBase();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const res = await fetch(`${base}/api/voice/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error("TTS failed");

    const player = playerRef.current!;
    await player.startBargeIn();
    setPipelineState("speaking");

    const reader = res.body.getReader();
    const CHUNK_SAMPLES = 44100 * 0.1; // ~100ms chunks for smooth playback

    let buffer = new Uint8Array(0);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Accumulate bytes
      const merged = new Uint8Array(buffer.length + value.length);
      merged.set(buffer);
      merged.set(value, buffer.length);
      buffer = merged;

      // Drain in chunks of CHUNK_SAMPLES * 4 bytes (f32le)
      const byteThreshold = CHUNK_SAMPLES * 4;
      while (buffer.length >= byteThreshold) {
        const chunk = buffer.slice(0, byteThreshold);
        buffer = buffer.slice(byteThreshold);
        const f32 = new Float32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
        player.enqueue(f32);
      }
    }
    // Flush remainder
    if (buffer.length >= 4) {
      const f32 = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
      player.enqueue(f32);
    }
  };

  // ── Full pipeline ────────────────────────────────────────────────────────────

  const runPipeline = useCallback(async (blob: Blob) => {
    setError(null);
    const uid = Date.now().toString();

    try {
      // 1. STT
      setPipelineState("transcribing");
      const transcript = await transcribeAudio(blob);
      if (!transcript) { setPipelineState("idle"); return; }

      // Show user message
      setMessages(prev => [...prev, { id: uid, role: "user", text: transcript }]);

      // 2. Agent
      setPipelineState("thinking");
      const answer = await runAgent(transcript, uid);

      // Show assistant message
      const aidId = Date.now().toString() + "-a";
      setMessages(prev => [...prev, { id: aidId, role: "assistant", text: answer }]);

      // 3. TTS
      await speakText(answer);

    } catch (e: any) {
      if (e.name === "AbortError") return; // barge-in, not an error
      setError(e.message || "Something went wrong");
    } finally {
      setPipelineState("idle");
      playerRef.current?.stopBarge();
      setAgentStatus("");
    }
  }, [messages]);

  // ── Recording ──────────────────────────────────────────────────────────────

  const startRecording = async () => {
    setError(null);
    // Stop any playing audio (barge-in on manual re-tap too)
    abortRef.current?.abort();
    playerRef.current?.stop();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        if (blob.size > 0) runPipeline(blob);
        else setPipelineState("idle");
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setPipelineState("recording");
    } catch (e: any) {
      setError(e.message || "Microphone access denied");
    }
  };

  const stopRecording = () => { mediaRecorderRef.current?.stop(); };

  const toggleMic = () => {
    if (pipelineState === "recording") stopRecording();
    else if (pipelineState === "idle") startRecording();
  };

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (isOpen) {
      playerRef.current = new StreamPlayer();
      playerRef.current.onBargein = () => {
        abortRef.current?.abort();
        setPipelineState("idle");
        startRecording();
      };
    } else {
      abortRef.current?.abort();
      playerRef.current?.dispose();
      playerRef.current = null;
      mediaRecorderRef.current?.stop();
      setPipelineState("idle");
      setAgentStatus("");
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, agentStatus]);

  if (!isOpen) return null;

  const micActive = pipelineState === "recording";
  const busy = pipelineState !== "idle" && pipelineState !== "recording";

  const stateLabel: Record<PipelineState, string> = {
    idle: "Tap to talk",
    recording: "Tap to send",
    transcribing: "Listening…",
    thinking: agentStatus || "Thinking…",
    speaking: "Speaking…",
  };

  return (
    <>
      <style>{`
        @keyframes voiceBar {
          0%, 100% { transform: scaleY(1); }
          50%       { transform: scaleY(2); }
        }
        @keyframes pulseMic {
          0%   { box-shadow: 0 0 0 0   rgba(139,92,246,0.7); }
          70%  { box-shadow: 0 0 0 24px rgba(139,92,246,0);   }
          100% { box-shadow: 0 0 0 0   rgba(139,92,246,0);   }
        }
        @keyframes vcFadeUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .vc-spin { animation: spin 1s linear infinite; }
      `}</style>

      <div style={{
        position: "fixed", inset: 0, zIndex: 20000,
        background: "var(--bg-color)",
        display: "flex", flexDirection: "column",
        animation: "vcFadeUp 0.22s ease",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 18px", borderBottom: "1px solid var(--border-color)",
          background: "var(--bg-2)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Volume2 size={18} style={{ color: "#a78bfa" }} />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Voice Agent</span>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: "2px 7px",
              background: "linear-gradient(135deg,#6d28d9,#8b5cf6)",
              color: "#fff", borderRadius: 10,
            }}>
              <Zap size={9} style={{ display: "inline", marginRight: 2 }} />
              Powered
            </span>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4 }}>
            <X size={22} />
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: "auto", padding: "18px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
          {messages.length === 0 && pipelineState === "idle" && (
            <div style={{ textAlign: "center", color: "var(--text-muted)", marginTop: 72 }}>
              <div style={{ fontSize: 44, marginBottom: 14 }}>🎙️</div>
              <p style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Your voice-controlled agent</p>
              <p style={{ fontSize: 12, opacity: 0.55 }}>Ask anything — it can browse the web,<br />check emails, run automations, and more.</p>
              <div style={{ marginTop: 20, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center" }}>
                {["Open YouTube", "Search Google for AI news", "Check unread emails", "Go to github.com"].map(ex => (
                  <span key={ex} style={{
                    fontSize: 11, padding: "5px 10px",
                    background: "var(--input-bg)", borderRadius: 20,
                    color: "var(--text-muted)", border: "1px solid var(--border-color)",
                  }}>{ex}</span>
                ))}
              </div>
            </div>
          )}

          {messages.map(m => (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", gap: 4 }}>
              <div style={{
                background: m.role === "user"
                  ? "linear-gradient(135deg,#6d28d9,#8b5cf6)"
                  : "var(--input-bg)",
                color: m.role === "user" ? "#fff" : "var(--text-primary)",
                borderRadius: m.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                padding: "10px 14px", maxWidth: "84%", fontSize: 13, lineHeight: 1.55,
              }}>
                {m.text}
              </div>
              {/* Agent events */}
              {m.agentEvents && m.agentEvents.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2, paddingLeft: 4, maxWidth: "84%" }}>
                  {m.agentEvents.map((ev, i) => (
                    <span key={i} style={{ fontSize: 10, color: "var(--text-muted)", opacity: 0.7 }}>⚡ {ev}</span>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Agent running status */}
          {(pipelineState === "thinking" || pipelineState === "transcribing") && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--input-bg)", borderRadius: 14, maxWidth: "80%", alignSelf: "flex-start" }}>
              <Loader2 size={13} className="vc-spin" style={{ color: "#a78bfa" }} />
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>{stateLabel[pipelineState]}</span>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Waveform status */}
        <div style={{ padding: "4px 16px 0", textAlign: "center", minHeight: 50 }}>
          {pipelineState === "recording" && <WaveBars active={true} color="#a78bfa" />}
          {pipelineState === "speaking" && <WaveBars active={true} count={14} color="#34d399" />}
          {error && <p style={{ fontSize: 12, color: "#dc2626", marginTop: 4 }}>{error}</p>}
        </div>

        {/* Mic button */}
        <div style={{ padding: "14px 0 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
          <button
            onClick={toggleMic}
            disabled={busy}
            style={{
              width: 78, height: 78, borderRadius: "50%", border: "none",
              cursor: busy ? "not-allowed" : "pointer",
              background: micActive
                ? "linear-gradient(135deg,#7c3aed,#a855f7)"
                : busy ? "var(--input-bg)"
                : "linear-gradient(135deg,#5b21b6,#7c3aed)",
              color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: micActive ? "none" : "0 6px 28px rgba(109,40,217,0.5)",
              animation: micActive ? "pulseMic 1.2s ease-out infinite" : "none",
              transform: micActive ? "scale(1.1)" : "scale(1)",
              transition: "transform 0.15s, background 0.2s",
              opacity: busy ? 0.35 : 1,
            }}
          >
            {micActive ? <MicOff size={32} /> : <Mic size={32} />}
          </button>
          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: 0 }}>
            {stateLabel[pipelineState]}
          </p>
        </div>
      </div>
    </>
  );
}
