app.py
import os
import threading
from flask import Flask, render_template
from telegram import Update, KeyboardButton, ReplyKeyboardMarkup, WebAppInfo
from telegram.ext import Application, CommandHandler, ContextTypes

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "http://127.0.0.1:8000/")

app = Flask(__name__)

@app.get("/")
def index():
    return render_template("index.html")

async def start_cmd(update: Update, context: ContextTypes.DEFAULT_TYPE):
    btn = KeyboardButton(text="Открыть тюнер", web_app=WebAppInfo(url=WEBAPP_URL))
    kb = ReplyKeyboardMarkup([[btn]], resize_keyboard=True)
    await update.message.reply_text(
        "Открой мини‑апп тюнера:",
        reply_markup=kb
    )

def run_bot():
    application = Application.builder().token(TELEGRAM_TOKEN).build()
    application.add_handler(CommandHandler("start", start_cmd))
    application.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    if not TELEGRAM_TOKEN:
        raise RuntimeError("Set TELEGRAM_TOKEN env var")
    bot_thread = threading.Thread(target=run_bot, daemon=True)
    bot_thread.start()
    app.run(host="0.0.0.0", port=8000)
