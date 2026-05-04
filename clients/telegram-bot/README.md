# Telegram Bot

Python Telegram bot client for the Agentic Browser backend.

Each message starts a new conversation thread. Replying to a bot message continues that thread.
Typing indicators are shown while the agent generates. Tool calls used are summarised at the bottom of each response.

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token.
2. Copy the example env file and fill in your token:
   ```bash
   cp clients/telegram-bot/.env.example clients/telegram-bot/.env
   # edit .env and set TELEGRAM_BOT_TOKEN
   ```
3. Install deps (from repo root):
   ```bash
   uv sync
   # or: pip install -e .
   ```

## Run

From the repo root, with the backend already running (`python main.py`):

```bash
python clients/telegram-bot/bot.py
```

## Conversation threading

| Scenario | Behaviour |
|---|---|
| New message | Fresh conversation — full agent context reset |
| Reply to a bot message | Continues the same conversation — history preserved |
| Reply to your own message | Treated as a new conversation |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | **Required.** Token from @BotFather |
| `BACKEND_URL` | `http://localhost:5454` | URL of the Agentic Browser backend |
