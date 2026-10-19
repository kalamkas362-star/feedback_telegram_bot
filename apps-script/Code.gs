/**
 * Сабақ соңындағы рефлексия Telegram-боты — Google Apps Script нұсқасы.
 *
 * Маңызды:
 * 1) BOT_TOKEN және ADMIN_CHAT_ID мәндерін өзіңіз енгізіңіз.
 * 2) Бұл файлды GitHub-тағы ашық репозиторийден көшіріп, жеке Google Apps
 *    Script жобаңызға салыңыз. Нақты токенді GitHub-қа ешқашан жүктемеңіз.
 * 3) Deploy > New deployment > Web app арқылы жариялаңыз.
 * 4) initializeBot() функциясын редактордан бір рет іске қосыңыз.
 */

const BOT_TOKEN = 'PASTE_YOUR_BOTFATHER_TOKEN_HERE';
const ADMIN_CHAT_ID = 'PASTE_YOUR_NUMERIC_TELEGRAM_CHAT_ID_HERE';

const PROP = PropertiesService.getScriptProperties();
const SHEET_ID_KEY = 'FEEDBACK_SHEET_ID';
const WEBHOOK_KEY = 'TELEGRAM_WEBHOOK_KEY';
const STATE_PREFIX = 'REFLECTION_STATE_';
const SHEET_NAME = 'Жауаптар';

const HEADERS = [
  'Уақыты', 'Оқушы', 'Username', 'Telegram ID',
  'Көңіл күйі', 'Түсіну деңгейі', 'Пікір'
];

function doGet() {
  // HtmlService ContentService-ке тән 302 redirect мәселесін болдырмауға көмектеседі.
  return htmlResponse_('Сабақ рефлексиясы ботының сервері жұмыс істеп тұр.');
}

/**
 * Web app жарияланғаннан кейін осы функцияны Apps Script редакторында Run етіңіз.
 * Google Sheets файлын дайындайды және Telegram webhook-ын қосады.
 */
function initializeBot() {
  if (!BOT_TOKEN || BOT_TOKEN.indexOf('PASTE_') === 0) {
    throw new Error('BOT_TOKEN мәніне BotFather берген нақты токенді енгізіңіз.');
  }
  if (!ADMIN_CHAT_ID || ADMIN_CHAT_ID.indexOf('PASTE_') === 0) {
    throw new Error('ADMIN_CHAT_ID мәніне өзіңіздің сандық Telegram ID нөміріңізді енгізіңіз.');
  }

  let sheetId = PROP.getProperty(SHEET_ID_KEY);
  let spreadsheet;

  if (sheetId) {
    spreadsheet = SpreadsheetApp.openById(sheetId);
  } else {
    spreadsheet = SpreadsheetApp.create('Сабақ рефлексиясы — жауаптар');
    sheetId = spreadsheet.getId();
    PROP.setProperty(SHEET_ID_KEY, sheetId);
  }

  let sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.autoResizeColumns(1, HEADERS.length);
  }

  const webAppUrl = ScriptApp.getService().getUrl();
  if (!webAppUrl) {
    throw new Error(
      'Алдымен Deploy > New deployment > Web app арқылы жариялап, содан кейін initializeBot() функциясын іске қосыңыз.'
    );
  }

  let secret = PROP.getProperty(WEBHOOK_KEY);
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    PROP.setProperty(WEBHOOK_KEY, secret);
  }

  const webhookUrl = webAppUrl + '?key=' + encodeURIComponent(secret);
  const result = telegramApi_('setWebhook', {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true
  });

  Logger.log('Webhook орнатылды: ' + JSON.stringify(result));
  Logger.log('Жауаптар Google кестесінде сақталады: ' + spreadsheet.getUrl());
  Logger.log('Ботты Telegram-да ашып, /start арқылы сынаңыз.');
}

function doPost(e) {
  try {
    const incomingKey = e && e.parameter ? e.parameter.key : '';
    const expectedKey = PROP.getProperty(WEBHOOK_KEY);
    if (!expectedKey || incomingKey !== expectedKey) {
      return htmlResponse_('Forbidden');
    }
    if (!e || !e.postData || !e.postData.contents) {
      return htmlResponse_('Empty request');
    }
    const update = JSON.parse(e.postData.contents);
    handleUpdate_(update);
    return htmlResponse_('ok');
  } catch (err) {
    console.error('Webhook өңдеу қатесі: ' + err + '\n' + (err.stack || ''));
    return htmlResponse_('error');
  }
}


function htmlResponse_(text) {
  const safeText = escapeHtml_(text);
  return HtmlService.createHtmlOutput(
    '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    safeText +
    '</body></html>'
  );
}

function handleUpdate_(update) {
  if (update.callback_query) {
    handleCallback_(update.callback_query);
    return;
  }
  if (!update.message || !update.message.chat || !update.message.from) return;

  const message = update.message;
  const chatId = String(message.chat.id);
  const user = message.from;
  const text = String(message.text || '').trim();

  if (text === '/start' || text.indexOf('/start@') === 0) {
    PropertiesService.getScriptProperties().deleteProperty(STATE_PREFIX + chatId);
    sendMessage_(chatId,
      'Сәлем! 👋 Сабақ соңындағы кері байланысқа қош келдің!\n\n' +
      'Үш қысқа сұраққа жауап бер. Пікірің сабақтарды жақсартуға көмектеседі.\n\n' +
      '<b>1-сұрақ. Бүгінгі сабақтан кейінгі көңіл күйің қандай?</b>',
      moodKeyboard_()
    );
    return;
  }

  if (text === '/myid' || text.indexOf('/myid@') === 0) {
    sendMessage_(chatId, 'Осы чаттың ID нөмірі: <code>' + escapeHtml_(chatId) + '</code>');
    return;
  }

  if (text === '/cancel' || text.indexOf('/cancel@') === 0) {
    PropertiesService.getScriptProperties().deleteProperty(STATE_PREFIX + chatId);
    sendMessage_(chatId, 'Кері байланыс тоқтатылды. Қайта бастау үшін /start жібер.');
    return;
  }

  if (text === '/stats' || text.indexOf('/stats@') === 0) {
    if (!isAdmin_(chatId)) {
      sendMessage_(chatId, 'Бұл пәрмен тек мұғалімге қолжетімді.');
    } else {
      sendStats_();
    }
    return;
  }

  if (text === '/export' || text.indexOf('/export@') === 0) {
    if (!isAdmin_(chatId)) {
      sendMessage_(chatId, 'Бұл пәрмен тек мұғалімге қолжетімді.');
    } else {
      sendCsv_();
    }
    return;
  }

  const state = getState_(chatId);
  if (state && state.stage === 'comment') {
    if (text.length > 1500) {
      sendMessage_(chatId, 'Пікірді 1500 таңбаға дейін қысқартып жібер.');
      return;
    }
    state.comment = text;
    finishFeedback_(user, chatId, state);
    return;
  }

  sendMessage_(chatId, 'Кері байланысты бастау үшін /start пәрменін жібер.');
}

function handleCallback_(query) {
  const callbackId = query.id;
  const data = String(query.data || '');
  const message = query.message;
  if (!message || !message.chat) {
    answerCallback_(callbackId);
    return;
  }

  const chatId = String(message.chat.id);
  const messageId = message.message_id;
  const user = query.from;
  answerCallback_(callbackId);

  let state = getState_(chatId) || {};

  if (data.indexOf('mood:') === 0) {
    state.mood = data.substring(5);
    state.stage = 'mood';
    saveState_(chatId, state);
    editMessage_(chatId, messageId,
      '✅ Таңдауың қабылданды.\n\n' +
      '<b>2-сұрақ. Бүгінгі тақырыпты қаншалықты түсіндің?</b>',
      understandingKeyboard_()
    );
    return;
  }

  if (data.indexOf('level:') === 0) {
    if (!state.mood) {
      editMessage_(chatId, messageId, 'Сауалнаманы бастау үшін /start пәрменін жібер.');
      return;
    }
    state.understanding = data.substring(6);
    state.stage = 'comment';
    saveState_(chatId, state);
    editMessage_(chatId, messageId,
      '<b>3-сұрақ. Сабақта не ұнады немесе нені жақсартуға болады?</b>\n\n' +
      'Пікіріңді келесі хабарлама ретінде жаз. Пікір қалдырғың келмесе, ' +
      'төмендегі батырманы бас.',
      commentKeyboard_()
    );
    return;
  }

  if (data === 'comment:skip') {
    if (!state.mood || !state.understanding) {
      editMessage_(chatId, messageId, 'Сауалнаманы бастау үшін /start пәрменін жібер.');
      return;
    }
    state.comment = '';
    finishFeedback_(user, chatId, state);
  }
}

function finishFeedback_(user, chatId, state) {
  try {
    const spreadsheet = SpreadsheetApp.openById(PROP.getProperty(SHEET_ID_KEY));
    const sheet = spreadsheet.getSheetByName(SHEET_NAME);
    const displayName = [user.first_name || '', user.last_name || ''].join(' ').trim()
      || user.username || 'Аты көрсетілмеген';
    const username = user.username ? '@' + user.username : '';
    const createdAt = new Date();

    sheet.appendRow([
      createdAt, displayName, username, String(user.id),
      state.mood || '', state.understanding || '', state.comment || ''
    ]);

    PROP.deleteProperty(STATE_PREFIX + String(chatId));

    // Оқушыға нақты жауаптар қайта көрсетілмейді.
    sendMessage_(chatId,
      'Рақмет! 🌟 Кері байланысың қабылданды.\n' +
      'Жауаптарың мен пікірің мұғалімге ғана жіберіледі.'
    );

    const report =
      '📩 <b>Жаңа сабақ рефлексиясы</b>\n\n' +
      '🕒 Уақыты: ' + escapeHtml_(createdAt.toLocaleString()) + '\n' +
      '👤 Оқушы: ' + escapeHtml_(displayName) +
      (username ? ' (' + escapeHtml_(username) + ')' : '') + '\n' +
      '🪪 Telegram ID: <code>' + escapeHtml_(String(user.id)) + '</code>\n' +
      '💛 Көңіл күйі: ' + escapeHtml_(state.mood || '—') + '\n' +
      '📘 Түсіну деңгейі: ' + escapeHtml_(state.understanding || '—') + '\n' +
      '💬 Пікірі: ' + escapeHtml_(state.comment || 'Пікір қалдырмады');

    sendMessage_(ADMIN_CHAT_ID, report);
  } catch (err) {
    console.error('Рефлексияны сақтау қатесі: ' + err + '\n' + (err.stack || ''));
    sendMessage_(chatId,
      'Жауапты сақтау кезінде қате болды. Біраздан соң /start арқылы қайта көр.'
    );
  }
}

function sendStats_() {
  const values = getRows_();
  const moods = {};
  const levels = {};
  values.forEach(function(row) {
    const mood = String(row[4] || '—');
    const level = String(row[5] || '—');
    moods[mood] = (moods[mood] || 0) + 1;
    levels[level] = (levels[level] || 0) + 1;
  });
  const moodText = Object.keys(moods).map(k => '• ' + k + ': ' + moods[k]).join('\n') || 'Әзірге жауап жоқ';
  const levelText = Object.keys(levels).map(k => '• ' + k + ': ' + levels[k]).join('\n') || 'Әзірге жауап жоқ';
  sendMessage_(ADMIN_CHAT_ID,
    '📊 <b>Кері байланыс статистикасы</b>\n\n' +
    'Жауап саны: <b>' + values.length + '</b>\n\n' +
    '<b>Көңіл күйі:</b>\n' + escapeHtml_(moodText) + '\n\n' +
    '<b>Түсіну деңгейі:</b>\n' + escapeHtml_(levelText)
  );
}

function sendCsv_() {
  const rows = getRows_();
  const csvRows = [HEADERS].concat(rows);
  const csv = '\uFEFF' + csvRows.map(function(row) {
    return row.map(function(cell) {
      let value = cell instanceof Date ? cell.toLocaleString() : String(cell == null ? '' : cell);
      return '"' + value.replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\r\n');
  const blob = Utilities.newBlob(csv, 'text/csv', 'sabak_refleksiyasy.csv');
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendDocument', {
    method: 'post',
    payload: { chat_id: ADMIN_CHAT_ID, document: blob, caption: 'Кері байланыс жауаптары: ' + rows.length + ' жазба.' },
    muteHttpExceptions: true
  });
  checkTelegramResponse_(response);
}

function getRows_() {
  const id = PROP.getProperty(SHEET_ID_KEY);
  if (!id) return [];
  const sheet = SpreadsheetApp.openById(id).getSheetByName(SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, HEADERS.length).getValues();
}

function moodKeyboard_() {
  return { inline_keyboard: [
    [{ text: '😄 Өте жақсы', callback_data: 'mood:Өте жақсы' }, { text: '🙂 Жақсы', callback_data: 'mood:Жақсы' }],
    [{ text: '😐 Орташа', callback_data: 'mood:Орташа' }, { text: '😕 Қиын болды', callback_data: 'mood:Қиын болды' }]
  ]};
}

function understandingKeyboard_() {
  return { inline_keyboard: [
    [{ text: '✅ Толық түсіндім', callback_data: 'level:Толық түсіндім' }],
    [{ text: '🟡 Жартылай түсіндім', callback_data: 'level:Жартылай түсіндім' }],
    [{ text: '❓ Қосымша түсіндіру қажет', callback_data: 'level:Қосымша түсіндіру қажет' }]
  ]};
}

function commentKeyboard_() {
  return { inline_keyboard: [
    [{ text: 'Өткізіп жіберу', callback_data: 'comment:skip' }]
  ]};
}

function sendMessage_(chatId, text, replyMarkup) {
  const payload = {
    chat_id: String(chatId),
    text: text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramApi_('sendMessage', payload);
}

function editMessage_(chatId, messageId, text, replyMarkup) {
  const payload = { chat_id: String(chatId), message_id: messageId, text: text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return telegramApi_('editMessageText', payload);
}

function answerCallback_(callbackId) {
  return telegramApi_('answerCallbackQuery', { callback_query_id: callbackId });
}

function telegramApi_(method, payload) {
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return checkTelegramResponse_(response);
}

function checkTelegramResponse_(response) {
  const status = response.getResponseCode();
  const text = response.getContentText();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) {
    throw new Error('Telegram API жауабы оқылмады: HTTP ' + status + ' ' + text);
  }
  if (status < 200 || status >= 300 || !parsed.ok) {
    throw new Error('Telegram API қатесі: HTTP ' + status + ' ' + text);
  }
  return parsed.result;
}

function getState_(chatId) {
  const raw = PROP.getProperty(STATE_PREFIX + String(chatId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function saveState_(chatId, state) {
  PROP.setProperty(STATE_PREFIX + String(chatId), JSON.stringify(state));
}

function isAdmin_(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

function escapeHtml_(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
