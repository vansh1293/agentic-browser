import json
import os
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, WebSocket, WebSocketDisconnect
from core import get_logger
from core.voice_pipeline import run_voice_pipeline
from faster_whisper import WhisperModel

router = APIRouter()
logger = get_logger(__name__)

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

_model = None


def get_whisper_model():
    global _model
    if _model is None:
        logger.info("Initializing faster-whisper model (tiny)...")
        _model = WhisperModel("tiny", device="cpu", compute_type="int8")
    return _model


@router.post("/transcribe", response_model=dict)
async def transcribe_voice(file: UploadFile = File(...)):
    """Transcribe voice audio to text using Whisper (legacy endpoint)."""
    temp_file_path = None
    try:
        if not file.content_type.startswith("audio/"):
            logger.warning(f"Unexpected content type for voice upload: {file.content_type}")

        unique_id = uuid.uuid4().hex[:8]
        extension = Path(file.filename or "audio.webm").suffix or ".webm"
        temp_filename = f"voice_{unique_id}{extension}"
        temp_file_path = UPLOAD_DIR / temp_filename

        contents = await file.read()
        temp_file_path.write_bytes(contents)
        logger.info(f"Voice audio received: {temp_filename} ({len(contents)} bytes)")

        model = get_whisper_model()
        segments, info = model.transcribe(str(temp_file_path), beam_size=5, language="en")
        logger.info(f"Detected language '{info.language}' with probability {info.language_probability}")

        full_transcript = " ".join(s.text for s in segments).strip()
        logger.info(f"Transcription complete: {full_transcript[:50]}...")

        return {
            "ok": True,
            "text": full_transcript,
            "language": info.language,
            "language_probability": info.language_probability,
        }

    except Exception as e:
        logger.error(f"Voice transcription error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    finally:
        if temp_file_path and temp_file_path.exists():
            try:
                temp_file_path.unlink()
            except Exception as e:
                logger.error(f"Failed to delete temporary voice file {temp_file_path}: {e}")


@router.websocket("/ws")
async def voice_websocket(websocket: WebSocket):
    """
    Full-duplex voice WebSocket.

    Protocol (client → server):
      - First message: JSON  { "history": [ {role, content}, ... ] }
      - Subsequent binary messages: raw audio bytes (webm)

    Protocol (server → client):
      - Binary frames:
          b"TEXT:" + utf8_text          → transcript or LLM text chunk
          b"AUDIO:" + 4-byte-len + pcm  → PCM f32le 44100 Hz audio
          b"DONE"                       → pipeline finished
          b"ERR:" + utf8_message        → error
    """
    await websocket.accept()
    logger.info("Voice WebSocket connected")

    history: list[dict] = []

    try:
        while True:
            message = await websocket.receive()

            # JSON control message (history)
            if "text" in message:
                try:
                    data = json.loads(message["text"])
                    history = data.get("history", [])
                    logger.info(f"Voice WS: received history ({len(history)} turns)")
                except json.JSONDecodeError:
                    await websocket.send_bytes(b"ERR:Invalid JSON")
                continue

            # Binary audio payload
            audio_bytes: bytes = message.get("bytes", b"")
            if not audio_bytes:
                continue

            logger.info(f"Voice WS: received {len(audio_bytes)} audio bytes — starting pipeline")

            try:
                async for chunk in run_voice_pipeline(audio_bytes, history):
                    await websocket.send_bytes(chunk)
                await websocket.send_bytes(b"DONE")

            except Exception as e:
                logger.error(f"Voice pipeline error: {e}", exc_info=True)
                await websocket.send_bytes(b"ERR:" + str(e).encode("utf-8"))

    except WebSocketDisconnect:
        logger.info("Voice WebSocket disconnected")
    except Exception as e:
        logger.error(f"Voice WebSocket error: {e}", exc_info=True)

