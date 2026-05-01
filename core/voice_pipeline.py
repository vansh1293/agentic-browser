"""
core/voice_pipeline.py

Parallel Voice Pipeline: STT → LLM → TTS

Architecture (Orato-style):
  1. Audio bytes → faster-whisper → transcript
  2. Transcript → LLM (streaming)
  3. LLM tokens accumulate into sentences; each sentence is immediately
     dispatched to Cartesia TTS → PCM audio bytes streamed back to caller.

This means TTS playback starts as soon as the *first sentence* is ready,
not after the full LLM response, giving near-realtime feel.
"""

import asyncio
import io
import logging
import os
import re
import tempfile
from typing import AsyncIterator

from cartesia import AsyncCartesia
from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

# ── Singleton models ──────────────────────────────────────────────────────────

_whisper: WhisperModel | None = None


def _get_whisper() -> WhisperModel:
    global _whisper
    if _whisper is None:
        logger.info("Loading faster-whisper model (base)…")
        _whisper = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper


# ── STT ───────────────────────────────────────────────────────────────────────


def transcribe_audio(audio_bytes: bytes, language: str = "en") -> str:
    """Transcribe raw audio bytes (webm/wav/mp3) → text."""
    model = _get_whisper()
    with tempfile.NamedTemporaryFile(suffix=".webm", delete=False) as f:
        f.write(audio_bytes)
        tmp_path = f.name

    try:
        segments, _ = model.transcribe(tmp_path, beam_size=5, language=language)
        return " ".join(s.text for s in segments).strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ── Sentence splitter ─────────────────────────────────────────────────────────

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def _split_into_sentences(text: str) -> list[str]:
    """Split text into complete sentences suitable for TTS chunking."""
    parts = _SENTENCE_END.split(text.strip())
    return [p.strip() for p in parts if p.strip()]


# ── LLM (streaming) ───────────────────────────────────────────────────────────


async def _stream_llm(transcript: str, history: list[dict]) -> AsyncIterator[str]:
    """
    Stream LLM tokens for the given transcript.
    Uses the project's configured LLM (via LangChain).
    """
    from langchain_google_genai import ChatGoogleGenerativeAI
    from langchain_core.messages import HumanMessage, SystemMessage, AIMessage

    api_key = os.getenv("GOOGLE_API_KEY")
    llm = ChatGoogleGenerativeAI(
        model=os.getenv("LLM_MODEL", "gemini-2.5-flash"),
        google_api_key=api_key,
        streaming=True,
    )

    messages = [
        SystemMessage(content=(
            "You are a helpful, concise voice assistant. "
            "Keep your answers short and conversational — no markdown, no bullet points. "
            "Respond as if speaking naturally."
        ))
    ]
    for msg in history[-10:]:  # last 10 turns for context
        if msg["role"] == "user":
            messages.append(HumanMessage(content=msg["content"]))
        else:
            messages.append(AIMessage(content=msg["content"]))

    messages.append(HumanMessage(content=transcript))

    async for chunk in llm.astream(messages):
        token: str = chunk.content  # type: ignore[assignment]
        if token:
            yield token


# ── TTS (Cartesia streaming) ──────────────────────────────────────────────────


async def _tts_sentence(client: AsyncCartesia, sentence: str) -> bytes:
    """Convert a single sentence to PCM audio bytes via Cartesia."""
    cartesia_voice_id = "a0e99841-438c-4a64-b679-ae501e7d6091"  # Barbershop Man (neutral)

    output = io.BytesIO()
    async for chunk in await client.tts.sse(
        transcript=sentence,
        voice_id=cartesia_voice_id,
        output_format={
            "container": "raw",
            "encoding": "pcm_f32le",
            "sample_rate": 44100,
        },
        model_id="sonic-2",
    ):
        if isinstance(chunk, bytes):
            output.write(chunk)
        elif hasattr(chunk, "audio"):
            output.write(chunk.audio)

    return output.getvalue()


# ── Public API ────────────────────────────────────────────────────────────────


async def run_voice_pipeline(
    audio_bytes: bytes,
    history: list[dict],
) -> AsyncIterator[bytes]:
    """
    Full pipeline:  audio_bytes → transcript → LLM tokens → TTS audio chunks.

    Yields:
      - First item: b"TEXT:" + transcript.encode()  (so UI can show the text)
      - Subsequent items: raw PCM f32le bytes at 44100 Hz per TTS sentence
    """
    # 1. STT
    transcript = await asyncio.get_event_loop().run_in_executor(
        None, transcribe_audio, audio_bytes
    )
    if not transcript:
        return

    # Yield transcript first so the UI can display it immediately
    yield b"TEXT:" + transcript.encode("utf-8")

    cartesia_key = os.getenv("CARTESIA_API_KEY", "")
    if not cartesia_key:
        logger.warning("CARTESIA_API_KEY not set — skipping TTS")
        return

    async with AsyncCartesia(api_key=cartesia_key) as cartesia_client:
        # 2. Stream LLM tokens, accumulate into sentences, TTS each sentence
        buffer = ""
        full_response = ""

        async for token in _stream_llm(transcript, history):
            buffer += token
            full_response += token

            # Check if we have at least one complete sentence in the buffer
            sentences = _SENTENCE_END.split(buffer)
            if len(sentences) > 1:
                # All but the last fragment are complete sentences
                complete = sentences[:-1]
                buffer = sentences[-1]  # keep the trailing incomplete part

                for sentence in complete:
                    sentence = sentence.strip()
                    if not sentence:
                        continue
                    # Yield text chunk so UI can stream the transcript live
                    yield b"TEXT:" + sentence.encode("utf-8")
                    # Kick off TTS for this sentence
                    audio = await _tts_sentence(cartesia_client, sentence)
                    if audio:
                        yield b"AUDIO:" + len(audio).to_bytes(4, "big") + audio

        # Flush any remaining buffer
        if buffer.strip():
            yield b"TEXT:" + buffer.strip().encode("utf-8")
            audio = await _tts_sentence(cartesia_client, buffer.strip())
            if audio:
                yield b"AUDIO:" + len(audio).to_bytes(4, "big") + audio
