"""
Сабақ соңындағы кері байланыс Telegram боты.
Token мен мұғалімнің chat ID-і тек орта айнымалыларынан оқылады.
"""
import csv
import html
import io
import logging
import os
import sqlite3
from datetime import datetime

from dotenv import load_dotenv
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, InputFile
from telegram.constants import ParseMode
from telegram.ext import (
    Application, CallbackQueryHandler, CommandHandler, ContextTypes,
    MessageHandler, filters,
)

load_dotenv()
BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_CHAT_ID_RAW = os.getenv("ADMIN_CHAT_ID", "").strip()
ADMIN_CHAT_ID = int(ADMIN_CHAT_ID_RAW) if ADMIN_CHAT_ID_RAW else None
DB_PATH = os.getenv("DATABASE_PATH", "feedback.db")

logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    level=logging.INFO,
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)
SESSIONS: dict[int, dict] = {}


def make_keyboard(rows):
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(text, callback_data=data) for text, data in row]
        for row in rows
    ])


MOOD_KEYBOARD = make_keyboard([
    [("😄 Өте жақсы", "mood:Өте жақсы"), ("🙂 Жақсы", "mood:Жақсы")],
    [("😐 Орташа", "mood:Орташа"), ("😕 Қиын болды", "mood:Қиын болды")],
])
UNDERSTANDING_KEYBOARD = make_keyboard([
    [("✅ Толық түсіндім", "level:Толық түсіндім")],
    [("🟡 Жартылай түсіндім", "level:Жартылай түсіндім")],
    [("❓ Қосымша түсіндіру қажет", "level:Қосымша түсіндіру қажет")],
])
COMMENT_KEYBOARD = make_keyboard([[("Өткізіп жіберу", "comment:skip")]])


def init_db():
    with sqlite3.connect(DB_PATH) as connection:
        connection.execute("""
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                username TEXT,
                full_name TEXT,
                mood TEXT NOT NULL,
                understanding TEXT NOT NULL,
                comment TEXT NOT NULL DEFAULT ''
            )
        """)
        connection.commit()


def save_feedback(user, data):
    created_at = datetime.now().astimezone().isoformat(timespec="seconds")
    with sqlite3.connect(DB_PATH) as connection:
        cursor = connection.execute(
            """INSERT INTO feedback
               (created_at, user_id, username, full_name, mood, understanding, comment)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                created_at, user.id, user.username or "", user.full_name or "",
                data["mood"], data["understanding"], data.get("comment", ""),
            ),
        )
        connection.commit()
        return cursor.lastrowid, created_at


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.effective_chat or not update.effective_user:
        return
    SESSIONS.pop(update.effective_chat.id, None)
    await update.effective_message.reply_text(
        "Сәлем! 👋 Сабақ соңындағы кері байланысқа қош келдің!\n\n"
        "3 қысқа сұраққа жауап бер. Жауабың келесі сабақтарды жақсартуға көмектеседі.\n\n"
        "1-сұрақ. Бүгінгі сабақтан кейінгі көңіл күйің қандай?",
        reply_markup=MOOD_KEYBOARD,
    )


async def myid(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat:
        await update.effective_message.reply_text(
            f"Осы чаттың ID нөмірі: {update.effective_chat.id}\n\n"
            "Бұл санды мұғалімнің ADMIN_CHAT_ID айнымалысына енгіз."
        )


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if update.effective_chat:
        SESSIONS.pop(update.effective_chat.id, None)
    await update.effective_message.reply_text(
        "Кері байланыс тоқтатылды. Қайта бастау үшін /start пәрменін жібер."
    )


async def handle_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    if not query or not query.message or not query.from_user:
        return
    await query.answer()
    chat_id = query.message.chat_id
    data = query.data or ""
    session = SESSIONS.setdefault(chat_id, {})

    if data.startswith("mood:"):
        session["mood"] = data.partition(":")[2]
        await query.edit_message_text(
            f"Көңіл күйің: {session['mood']}\n\n"
            "2-сұрақ. Бүгінгі тақырыпты қаншалықты түсіндің?",
            reply_markup=UNDERSTANDING_KEYBOARD,
        )
        return

    if data.startswith("level:"):
        if "mood" not in session:
            await query.edit_message_text("Сауалнаманы бастау үшін /start жібер.")
            return
        session["understanding"] = data.partition(":")[2]
        await query.edit_message_text(
            f"Түсіну деңгейі: {session['understanding']}\n\n"
            "3-сұрақ. Сабақта не ұнады немесе нені жақсартуға болады?\n"
            "Пікіріңді келесі хабарлама ретінде жаз. Пікір қалдырғың келмесе, "
            "төмендегі батырманы бас.",
            reply_markup=COMMENT_KEYBOARD,
        )
        return

    if data == "comment:skip":
        if "mood" not in session or "understanding" not in session:
            await query.edit_message_text("Сауалнаманы бастау үшін /start жібер.")
            return
        session["comment"] = ""
        await query.edit_message_text("Жауабыңды сақтап жатырмын…")
        await finish_feedback(query.from_user, chat_id, context)


async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.effective_chat or not update.effective_user or not update.effective_message:
        return
    chat_id = update.effective_chat.id
    session = SESSIONS.get(chat_id)
    if not session or "mood" not in session or "understanding" not in session:
        await update.effective_message.reply_text(
            "Кері байланысты бастау үшін /start пәрменін жібер."
        )
        return
    comment = update.effective_message.text.strip()
    if len(comment) > 1500:
        await update.effective_message.reply_text(
            "Пікір тым ұзақ. 1500 таңбаға дейін қысқартып жібер."
        )
        return
    session["comment"] = comment
    await finish_feedback(update.effective_user, chat_id, context)


async def finish_feedback(user, chat_id: int, context: ContextTypes.DEFAULT_TYPE):
    data = SESSIONS.pop(chat_id, {})
    try:
        response_id, created_at = save_feedback(user, data)
    except Exception:
        logger.exception("Жауап дерекқорға сақталмады")
        await context.bot.send_message(
            chat_id=chat_id,
            text="Жауапты сақтау кезінде қате болды. /start арқылы қайта көр."
        )
        return

    await context.bot.send_message(
        chat_id=chat_id,
        text="Рақмет! 🌟 Кері байланысың қабылданды.\n"
             "Жауабың келесі сабақтарды жақсартуға көмектеседі.",
    )

    if ADMIN_CHAT_ID is None:
        logger.warning("ADMIN_CHAT_ID орнатылмаған. Жауап #%s тек базаға сақталды.", response_id)
        return

    comment = data.get("comment", "").strip() or "Пікір қалдырмады"
    username = f"@{user.username}" if user.username else "username жоқ"
    report = (
        "📩 <b>Жаңа сабақ рефлексиясы</b>\n\n"
        f"🆔 Жауап №: <code>{response_id}</code>\n"
        f"🕒 Уақыты: {html.escape(created_at)}\n"
        f"👤 Оқушы: {html.escape(user.full_name)} ({html.escape(username)})\n"
        f"🪪 User ID: <code>{user.id}</code>\n"
        f"💛 Көңіл күйі: {html.escape(data.get('mood', '—'))}\n"
        f"📘 Түсіну деңгейі: {html.escape(data.get('understanding', '—'))}\n"
        f"💬 Пікірі: {html.escape(comment)}"
    )
    try:
        await context.bot.send_message(
            chat_id=ADMIN_CHAT_ID, text=report, parse_mode=ParseMode.HTML
        )
    except Exception:
        logger.exception("Мұғалімге хабарлама жіберілмеді. ADMIN_CHAT_ID мәнін тексеріңіз.")


def is_admin(update: Update) -> bool:
    return (
        ADMIN_CHAT_ID is not None
        and update.effective_chat is not None
        and update.effective_chat.id == ADMIN_CHAT_ID
    )


async def stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.effective_message.reply_text("Бұл пәрмен тек мұғалімге қолжетімді.")
        return
    with sqlite3.connect(DB_PATH) as connection:
        total = connection.execute("SELECT COUNT(*) FROM feedback").fetchone()[0]
        moods = connection.execute(
            "SELECT mood, COUNT(*) FROM feedback GROUP BY mood ORDER BY COUNT(*) DESC"
        ).fetchall()
        levels = connection.execute(
            "SELECT understanding, COUNT(*) FROM feedback "
            "GROUP BY understanding ORDER BY COUNT(*) DESC"
        ).fetchall()
    mood_text = "\n".join(f"• {m}: {n}" for m, n in moods) or "Әзірге жауап жоқ"
    level_text = "\n".join(f"• {value}: {n}" for value, n in levels) or "Әзірге жауап жоқ"
    await update.effective_message.reply_text(
        f"📊 <b>Кері байланыс статистикасы</b>\n\nЖауап саны: <b>{total}</b>\n\n"
        f"<b>Көңіл күйі:</b>\n{html.escape(mood_text)}\n\n"
        f"<b>Түсіну деңгейі:</b>\n{html.escape(level_text)}",
        parse_mode=ParseMode.HTML,
    )


async def export_csv(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.effective_message.reply_text("Бұл пәрмен тек мұғалімге қолжетімді.")
        return
    with sqlite3.connect(DB_PATH) as connection:
        rows = connection.execute(
            """SELECT id, created_at, full_name, username, user_id,
                      mood, understanding, comment
               FROM feedback ORDER BY id DESC"""
        ).fetchall()
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow([
        "№", "Уақыты", "Оқушы", "Username", "User ID",
        "Көңіл күйі", "Түсіну деңгейі", "Пікір",
    ])
    writer.writerows(rows)
    document = InputFile(
        io.BytesIO(("\ufeff" + output.getvalue()).encode("utf-8")),
        filename="sabak_refleksiyasy.csv",
    )
    await update.effective_message.reply_document(
        document=document, caption=f"📄 Кері байланыс жауаптары: {len(rows)} жазба."
    )


async def post_init(application: Application):
    init_db()
    logger.info("Дерекқор дайын. Бот іске қосылды.")


def main():
    if not BOT_TOKEN:
        raise RuntimeError(
            "BOT_TOKEN табылмады. .env файлын немесе хостингтегі "
            "BOT_TOKEN орта айнымалысын баптаңыз."
        )
    application = Application.builder().token(BOT_TOKEN).post_init(post_init).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("myid", myid))
    application.add_handler(CommandHandler("cancel", cancel))
    application.add_handler(CommandHandler("stats", stats))
    application.add_handler(CommandHandler("export", export_csv))
    application.add_handler(CallbackQueryHandler(handle_button))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    logger.info("Telegram боты polling режимінде іске қосылып жатыр.")
    application.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
