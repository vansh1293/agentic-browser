from core.config import get_settings, get_logger

settings = get_settings()
logger = get_logger(__name__)

if not settings.telegram_bot_token:
    raise ValueError(
        "TELEGRAM_BOT_TOKEN is not set. Add it to your .env file as TELEGRAM_BOT_TOKEN=..."
    )
