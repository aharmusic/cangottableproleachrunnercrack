// whatsapp-telegram-bridge.js
// Dependencies: whatsapp-web.js, node-telegram-bot-api, qrcode, fs
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Use env var for token when possible. Fallback to inline token if you pasted one.
const token = process.env.TELEGRAM_BOT_TOKEN || '7659859177:AAHP8MkaFgQ9jJp1oM5vz5p98xYvdP3xKkI';
if (!token) {
  console.error('No Telegram token found. Set TELEGRAM_BOT_TOKEN env var or update the script.');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

// State
const clients = {};   // telegramChatId -> whatsapp client
const userState = {}; // telegramChatId -> { action, number }

// Utility: pick extension from mime
function extFromMime(mime) {
  if (!mime) return 'bin';
  const m = mime.split('/')[1];
  if (!m) return 'bin';
  // normalize common image mime types
  if (m.includes('jpeg') || m === 'jpg') return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('gif')) return 'gif';
  if (m.includes('mp4')) return 'mp4';
  if (m.includes('mpeg')) return 'mp3';
  return m;
}

// Create a WhatsApp client for a Telegram chat owner
function createClient(telegramChatId) {
  console.log(`Creating WhatsApp client for Telegram chat ${telegramChatId}`);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: `client-${telegramChatId}` }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  // QR handler
  client.on('qr', (qr) => {
    qrcode.toDataURL(qr, (err, url) => {
      if (err) {
        console.error('QR generation error:', err);
        bot.sendMessage(telegramChatId, 'Error generating QR code. Please try /scan again.');
        return;
      }

      const buffer = Buffer.from(url.split(',')[1], 'base64');

      // IMPORTANT: pass Buffer as 2nd arg, options as 3rd, fileOptions as 4th
      bot.sendPhoto(telegramChatId, buffer, { caption: 'Scan this QR code with WhatsApp to connect.' }, { filename: 'qrcode.png' })
        .catch(err => {
          console.error('sendPhoto(qr) failed, trying sendDocument fallback:', err && err.toString());
          // fallback to sendDocument
          bot.sendDocument(telegramChatId, buffer, { caption: 'Scan this QR code with WhatsApp to connect.' }, { filename: 'qrcode.png' })
            .catch(e => {
              console.error('Fallback sendDocument for QR failed:', e);
              bot.sendMessage(telegramChatId, 'Failed to send QR. Check logs.');
            });
        });
    });
  });

  client.on('ready', () => {
    console.log(`WhatsApp client ready for Telegram chat ${telegramChatId}`);
    clients[telegramChatId] = client;
    client.messageMap = new Map(); // track mapping: telegramMessageId -> whatsappChatId
    bot.sendMessage(telegramChatId, '✅ WhatsApp client connected and ready!');
  });

  client.on('message', async (message) => {
    // Send incoming WhatsApp messages to the Telegram owner
    try {
      const chat = await message.getChat();
      const contact = await message.getContact();
      const senderName = contact.pushname || contact.name || `+${contact.number}`;
      const senderNumber = `+${contact.number}`;
      const chatName = chat.isGroup ? ` in group "${chat.name}"` : '';
      const captionPrefix = `*New message from ${senderName} (${senderNumber})${chatName}:*\n\n`;

      if (message.hasMedia) {
        const media = await message.downloadMedia();
        if (!media || !media.data) {
          console.warn('media download returned nothing');
          return;
        }
        const mediaBuffer = Buffer.from(media.data, 'base64');
        const ext = extFromMime(media.mimetype);
        const filename = `media.${ext}`;

        // Try sendPhoto if likely image, otherwise sendDocument
        if (media.mimetype && media.mimetype.startsWith('image/')) {
          await bot.sendPhoto(telegramChatId, mediaBuffer, { caption: captionPrefix + (message.body || ''), parse_mode: 'Markdown' }, { filename })
            .then(sent => {
              client.messageMap.set(sent.message_id, message.from);
            })
            .catch(async (err) => {
              console.warn('sendPhoto failed, trying sendDocument:', err && err.toString());
              await bot.sendDocument(telegramChatId, mediaBuffer, { caption: captionPrefix + (message.body || ''), parse_mode: 'Markdown' }, { filename: `file.${ext}` })
                .then(sent => {
                  client.messageMap.set(sent.message_id, message.from);
                })
                .catch(e => console.error('sendDocument fallback failed:', e));
            });
        } else {
          // Non-image media: send as document
          await bot.sendDocument(telegramChatId, mediaBuffer, { caption: captionPrefix + (message.body || ''), parse_mode: 'Markdown' }, { filename })
            .then(sent => {
              client.messageMap.set(sent.message_id, message.from);
            })
            .catch(err => {
              console.error('Failed to send media to Telegram:', err);
            });
        }
      } else {
        // Text only
        const text = captionPrefix + (message.body || '');
        await bot.sendMessage(telegramChatId, text, { parse_mode: 'Markdown' })
          .then(sent => client.messageMap.set(sent.message_id, message.from))
          .catch(err => console.error('Error sending text to Telegram:', err));
      }
    } catch (err) {
      console.error('Error in client.on("message") handler:', err);
    }
  });

  client.on('disconnected', (reason) => {
    console.log(`WhatsApp client for Telegram chat ${telegramChatId} disconnected:`, reason);
    bot.sendMessage(telegramChatId, '⚠️ WhatsApp client disconnected (logged out). Use /scan to reconnect.');
    delete clients[telegramChatId];

    const sessionPath = path.join(process.cwd(), '.wwebjs_auth', `client-${telegramChatId}`);
    if (fs.existsSync(sessionPath)) {
      try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
      } catch (e) {
        console.warn('Failed to delete session folder:', e && e.toString());
      }
    }
  });

  client.initialize().catch(e => {
    console.error('Failed to initialize WhatsApp client:', e);
    bot.sendMessage(telegramChatId, 'Failed to initialize WhatsApp client. Check logs.');
  });

  return client;
}

// --- Telegram commands ---
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const text = `Welcome! Use /scan to connect your WhatsApp account via QR code. Use /help for commands.`;
  bot.sendMessage(chatId, text);
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const help = `
*WhatsApp-Telegram Bridge Help*

/scan - generate QR and link WhatsApp
/logout - disconnect WhatsApp
/send <+number> - start sending a new message to a number
/cancel - cancel a pending /send action
`;
  bot.sendMessage(chatId, help, { parse_mode: 'Markdown' });
});

bot.onText(/\/scan/, (msg) => {
  const chatId = msg.chat.id;
  if (clients[chatId]) {
    bot.sendMessage(chatId, 'You are already connected. Use /logout to disconnect first.');
  } else {
    bot.sendMessage(chatId, 'Generating QR code...').then(() => createClient(chatId));
  }
});

bot.onText(/\/logout/, async (msg) => {
  const chatId = msg.chat.id;
  const client = clients[chatId];
  if (!client) return bot.sendMessage(chatId, 'You are not connected.');
  try {
    await client.logout();
    bot.sendMessage(chatId, 'Logged out from WhatsApp.');
  } catch (err) {
    console.error('Logout error:', err);
    bot.sendMessage(chatId, 'Error while logging out. Check logs.');
  }
});

// /send number -> waits for next message (text or image) to deliver
bot.onText(/\/send (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const number = match[1].trim();
  if (!clients[chatId]) return bot.sendMessage(chatId, 'You must connect first with /scan.');

  if (!/^\+?\d{10,15}$/.test(number)) {
    return bot.sendMessage(chatId, 'Invalid number format. Use e.g. /send +1234567890');
  }

  userState[chatId] = { action: 'awaiting_message', number };
  bot.sendMessage(chatId, `Send the message (text or image) you want to deliver to ${number}. Use /cancel to abort.`, { parse_mode: 'Markdown' });
});

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (userState[chatId]) {
    delete userState[chatId];
    bot.sendMessage(chatId, 'Operation cancelled.');
  } else {
    bot.sendMessage(chatId, 'Nothing to cancel.');
  }
});

// Main message handler: handles replies and pending /send content
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // ignore commands here
  if (msg.text && msg.text.startsWith('/')) return;

  const client = clients[chatId];
  if (!client) return; // not connected

  // 1) Handle a pending /send
  if (userState[chatId] && userState[chatId].action === 'awaiting_message') {
    const number = userState[chatId].number;
    const whatsappChatId = (number.startsWith('+') ? number.slice(1) : number) + '@c.us';
    delete userState[chatId];

    try {
      await bot.sendMessage(chatId, `Sending your message to ${number}...`);
      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        const fileStream = bot.getFileStream(photo.file_id);
        const chunks = [];
        for await (const chunk of fileStream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const media = new MessageMedia('image/jpeg', buffer.toString('base64'), 'image.jpg');
        await client.sendMessage(whatsappChatId, media, { caption: msg.caption || '' });
        await bot.sendMessage(chatId, `✅ Image sent to ${number}`);
      } else if (msg.document) {
        // document sent by user
        const fileStream = bot.getFileStream(msg.document.file_id);
        const chunks = [];
        for await (const chunk of fileStream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const mime = msg.document.mime_type || 'application/octet-stream';
        const filename = msg.document.file_name || 'file';
        const media = new MessageMedia(mime, base64, filename);
        await client.sendMessage(whatsappChatId, media, { caption: msg.caption || '' });
        await bot.sendMessage(chatId, `✅ Document sent to ${number}`);
      } else if (msg.text) {
        await client.sendMessage(whatsappChatId, msg.text);
        await bot.sendMessage(chatId, `✅ Message sent to ${number}`);
      } else {
        await bot.sendMessage(chatId, 'Unsupported message type for /send. Use text, photo or document.');
      }
    } catch (err) {
      console.error('Error sending /send content to WhatsApp:', err);
      bot.sendMessage(chatId, `❌ Failed to send message to ${number}. Check logs.`);
    }
    return;
  }

  // 2) Handle reply to forwarded Telegram message -> send to original WhatsApp chat
  if (msg.reply_to_message && client.messageMap && client.messageMap.size) {
    const originalMessageId = msg.reply_to_message.message_id;
    const whatsappTarget = client.messageMap.get(originalMessageId);
    if (!whatsappTarget) return; // not a mapped forwarded message

    try {
      if (msg.photo) {
        const photo = msg.photo[msg.photo.length - 1];
        const fileStream = bot.getFileStream(photo.file_id);
        const chunks = [];
        for await (const chunk of fileStream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const media = new MessageMedia('image/jpeg', buffer.toString('base64'), 'reply.jpg');
        await client.sendMessage(whatsappTarget, media, { caption: msg.caption || '' });
        await bot.sendMessage(chatId, '✅ Image reply sent to WhatsApp!');
      } else if (msg.document) {
        const fileStream = bot.getFileStream(msg.document.file_id);
        const chunks = [];
        for await (const chunk of fileStream) chunks.push(chunk);
        const buffer = Buffer.concat(chunks);
        const base64 = buffer.toString('base64');
        const mime = msg.document.mime_type || 'application/octet-stream';
        const filename = msg.document.file_name || 'file';
        const media = new MessageMedia(mime, base64, filename);
        await client.sendMessage(whatsappTarget, media, { caption: msg.caption || '' });
        await bot.sendMessage(chatId, '✅ Document reply sent to WhatsApp!');
      } else if (msg.text) {
        await client.sendMessage(whatsappTarget, msg.text);
        await bot.sendMessage(chatId, '✅ Reply sent to WhatsApp!');
      }
    } catch (err) {
      console.error('Failed to forward reply to WhatsApp:', err);
      bot.sendMessage(chatId, '❌ Failed to send reply to WhatsApp.');
    }
  }
});

// global handlers
process.on('unhandledRejection', (r) => console.error('Unhandled Rejection:', r));
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));

console.log('Telegram bot started and polling...');
