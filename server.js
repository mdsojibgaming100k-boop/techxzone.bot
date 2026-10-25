const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'config.json');

// ১. Gemini API Key হ্যান্ডলিং
function getApiKey() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (data.apiKey && data.apiKey.trim()) return data.apiKey.trim();
    } catch (e) {}
  }
  return process.env.GEMINI_API_KEY || "";
}

let currentApiKey = getApiKey();
let genAI = currentApiKey ? new GoogleGenerativeAI(currentApiKey) : null;

let isConnected = false;
let pairingCode = null;
let sock = null;
let productCatalog = [];
const conversationHistory = new Map();

// ২. TechXZone প্রোডাক্ট ক্যাটালগ
async function updateCatalog() {
  try {
    const res = await axios.get('https://techxzone.shop/api.php?action=bot_catalog');
    if (res.data && res.data.products) {
      productCatalog = res.data.products;
      console.log(`[TechXZone] মোট ${productCatalog.length} টি প্রোডাক্ট লোড হয়েছে।`);
    }
  } catch (err) {
    console.error("[TechXZone] ক্যাটালগ লোড এরর:", err.message);
  }
}
updateCatalog();
setInterval(updateCatalog, 15 * 60 * 1000);

// ৩. Gemini AI রিপ্লাই ইঞ্জিন
async function generateAiReply(userPhone, userMessage) {
  if (!genAI || !currentApiKey) {
    return "আসসালামু আলাইকুম! বর্তমানে AI সার্ভিস সেটআপ করা হচ্ছে। সরাসরি কল করুন: 01771049068।";
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    let history = conversationHistory.get(userPhone) || [];

    const systemPrompt = `
তুমি TechXZone (techxzone.shop) এর অত্যন্ত দক্ষ, বিনয়ী ও স্মার্ট কাস্টমার সাপোর্ট ও সেলস এক্সিকিউটিভ।

নিয়মাবলী:
১. সবসময় মিষ্টি ও স্বাভাবিক বাংলায় কথা বলবে। নিজেকে TechXZone-এর বাস্তব কাস্টমার প্রতিনিধি হিসেবে উপস্থাপন করবে।
২. কাস্টমার যে প্রোডাক্টের তথ্য বা দাম জানতে চাইবে, নিচে দেওয়া লাইভ ক্যাটালগ দেখে সঠিক দাম, স্টক এবং কেনার সরাসরি লিংক (buy_link) দিয়ে দেবে।
৩. জানাবে সারা বাংলাদেশে ১০০% ক্যাশ অন ডেলিভারি (Cash on Delivery) সুবিধা আছে।
৪. উত্তর সংক্ষিপ্ত ও স্পষ্ট রাখবে।

TechXZone এর বর্তমান প্রোডাক্ট ক্যাটালগ:
${JSON.stringify(productCatalog, null, 2)}
    `;

    history.push({ role: "user", parts: [{ text: userMessage }] });
    if (history.length > 8) history = history.slice(-8);

    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "জি, আমি TechXZone এর পক্ষ থেকে কাস্টমারকে তথ্য ও অর্ডার লিংক দিয়ে সাহায্য করতে প্রস্তুত।" }] },
        ...history.slice(0, -1)
      ]
    });

    const result = await chat.sendMessage(userMessage);
    const replyText = result.response.text();

    history.push({ role: "model", parts: [{ text: replyText }] });
    conversationHistory.set(userPhone, history);

    return replyText;
  } catch (error) {
    console.error("Gemini AI Error:", error.message);
    return "আসসালামু আলাইকুম! বিস্তারিত জানতে ভিজিট করুন techxzone.shop অথবা কল করুন: 01771049068।";
  }
}

// ৪. WhatsApp Baileys ইঞ্জিন
async function initWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('txz_auth_session');

  sock = makeWASocket({
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) initWhatsApp();
    } else if (connection === 'open') {
      isConnected = true;
      pairingCode = null;
      console.log('🎉 [TechXZone WhatsApp Bot] কানেক্টেড হয়েছে!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    if (sender.includes('@g.us')) return;

    const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
    if (!text) return;

    const aiReply = await generateAiReply(sender, text);
    await sock.sendMessage(sender, { text: aiReply });
  });
}

// ৫. ওয়েব ড্যাশবোর্ড (পেয়ারিং কোড ও এপিআই কি সেটিং)
app.get('/', (req, res) => {
  const keyStatus = currentApiKey ? `<span style="color:#059669;font-weight:bold;">সেট করা আছে ✅</span>` : `<span style="color:#dc2626;font-weight:bold;">কোনো Key সেট করা নেই ❌</span>`;

  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TechXZone WhatsApp Pairing</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 20px; }
        .card { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 24px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; }
        input[type="text"] { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 12px; border: 1.5px solid #cbd5e1; font-size: 15px; margin-top: 6px; outline: none; }
        input[type="text"]:focus { border-color: #059669; }
        button { width: 100%; background: #059669; color: #fff; border: none; padding: 12px; border-radius: 12px; font-weight: bold; font-size: 15px; cursor: pointer; margin-top: 10px; }
        button:hover { background: #047857; }
        .code-box { background: #ecfdf5; border: 2px dashed #059669; border-radius: 16px; padding: 18px; text-align: center; margin: 15px 0; }
        .code-text { font-size: 32px; font-weight: 900; letter-spacing: 5px; color: #047857; font-family: monospace; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="margin:0 0 6px;text-align:center;color:#0f172a;">TechXZone WhatsApp Bot</h2>
        <p style="text-align:center;color:#64748b;font-size:13px;margin:0 0 20px;">Pairing Code & Settings Dashboard</p>

        <!-- WhatsApp স্ট্যাটাস ও পেয়ারিং কোড বক্স -->
        <div style="background:#f1f5f9;padding:18px;border-radius:18px;margin-bottom:20px;">
          ${isConnected 
            ? `<div style="color:#059669;font-weight:bold;font-size:18px;text-align:center;">✅ WhatsApp সফলভাবে কানেক্টেড আছে!</div>
               <p style="margin:6px 0 0;font-size:13px;color:#64748b;text-align:center;">বট লাইভ আছে এবং কাস্টমারদের উত্তর দিচ্ছে।</p>`
            : (pairingCode 
                ? `<div class="code-box">
                    <p style="margin:0 0 8px;font-size:13px;color:#065f46;font-weight:bold;">আপনার WhatsApp Pairing Code:</p>
                    <div class="code-text">${pairingCode}</div>
                    <p style="font-size:12px;color:#475569;margin:10px 0 0;line-height:1.5;">
                      <b>মোবাইলে যেভাবে বসাবেন:</b><br>
                      WhatsApp খুলুন ➡️ <b>Linked Devices</b> ➡️ <b>Link a Device</b> ➡️ নিচে <b>"Link with phone number instead"</b> চাপুন এবং এই কোডটি লিখুন!
                    </p>
                   </div>`
                : `<form action="/get-code" method="POST">
                    <label style="font-size:13px;font-weight:bold;color:#334155;">WhatsApp নম্বর দিয়ে পেয়ারিং কোড নিন:</label>
                    <input type="text" name="phone" placeholder="যেমন: 8801771049068 (কান্ট্রি কোড সহ)" required />
                    <button type="submit">📲 Get Pairing Code (কোড নিন)</button>
                    <p style="font-size:11px;color:#64748b;margin:8px 0 0;text-align:center;">কোনো ক্যামেরা বা QR স্ক্যানের দরকার নেই।</p>
                   </form>`
              )
          }
        </div>

        <!-- Gemini API Key সেকশন -->
        <div style="border-top:1px solid #e2e8f0;padding-top:16px;">
          <div style="font-size:13px;margin-bottom:8px;">AI স্ট্যাটাস: ${keyStatus}</div>
          <form action="/save-key" method="POST">
            <label style="font-size:12px;font-weight:bold;color:#475569;">Gemini API Key পরিবর্তন করুন:</label>
            <input type="text" name="apiKey" placeholder="নতুন Key পেস্ট করুন..." value="${currentApiKey ? currentApiKey.substring(0, 8) + '...' + currentApiKey.slice(-4) : ''}" required />
            <button type="submit" style="background:#0f172a;">💾 Save API Key</button>
          </form>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ৬. পেয়ারিং কোড রিকোয়েস্ট রুট
app.post('/get-code', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.redirect('/');

  try {
    if (sock && !sock.authState.creds.registered) {
      await delay(2000);
      const code = await sock.requestPairingCode(phone);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log(`[WhatsApp] পেয়ারিং কোড তৈরি হয়েছে: ${pairingCode}`);
    }
  } catch (err) {
    console.error("[WhatsApp] পেয়ারিং কোড এরর:", err.message);
  }

  res.redirect('/');
});

// ৭. API Key সেভ রুট
app.post('/save-key', (req, res) => {
  const newKey = (req.body.apiKey || '').trim();
  if (newKey) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: newKey }, null, 2));
    currentApiKey = newKey;
    genAI = new GoogleGenerativeAI(currentApiKey);
  }
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initWhatsApp();
});
