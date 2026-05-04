import asyncio
import logging

from telegram import Update, ChatAction
from telegram.constants import ParseMode
from telegram.error import BadRequest
from telegram.ext import ContextTypes

import backend
import store

logger = logging.getLogger(__name__)


async def _keep_typing(bot, chat_id: int, stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)
        except Exception:
            pass
        await asyncio.sleep(4)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    message = update.effective_message
    if not message or not message.text:
        return

    chat_id = message.chat_id
    question = message.text

    # Resolve conversation thread
    conversation_id: str | None = None
    reply = message.reply_to_message
    if reply and reply.from_user and reply.from_user.is_bot:
        conversation_id = await store.get(reply.message_id)

    # Typing indicator
    stop_event = asyncio.Event()
    typing_task = asyncio.create_task(_keep_typing(context.bot, chat_id, stop_event))

    try:
        result = await backend.stream_response(question, conversation_id)
    finally:
        stop_event.set()
        typing_task.cancel()
        try:
            await typing_task
        except asyncio.CancelledError:
            pass

    if result.error:
        await message.reply_text(f"⚠️ {result.error}")
        return

    # Build response text
    text = result.answer or "_(no response)_"
    if result.tool_calls:
        tools_line = " · ".join(result.tool_calls)
        text += f"\n\n──────────────────\n🔧 Tools used: {tools_line}"

    # Send with Markdown, fall back to plain text if parsing fails
    sent = None
    try:
        sent = await message.reply_text(text, parse_mode=ParseMode.MARKDOWN)
    except BadRequest as exc:
        logger.warning("Markdown parse failed (%s), retrying as plain text.", exc)
        try:
            sent = await message.reply_text(text)
        except Exception as exc2:
            logger.error("Failed to send reply: %s", exc2)
            return

    # Store bot_message_id → conversation_id for thread continuity
    if sent and result.conversation_id:
        await store.save(sent.message_id, result.conversation_id)
