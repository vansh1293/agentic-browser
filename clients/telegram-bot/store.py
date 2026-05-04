from sqlmodel import SQLModel, Field
from sqlalchemy import text

from core.db import engine, get_session


class TelegramSession(SQLModel, table=True):
    __tablename__ = "telegram_sessions"

    bot_message_id: int = Field(primary_key=True)
    conversation_id: str


async def init() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(TelegramSession.__table__.create, checkfirst=True)


async def save(bot_message_id: int, conversation_id: str) -> None:
    async with get_session() as session:
        existing = await session.get(TelegramSession, bot_message_id)
        if existing:
            existing.conversation_id = conversation_id
        else:
            session.add(TelegramSession(bot_message_id=bot_message_id, conversation_id=conversation_id))


async def get(bot_message_id: int) -> str | None:
    async with get_session() as session:
        record = await session.get(TelegramSession, bot_message_id)
        return record.conversation_id if record else None
