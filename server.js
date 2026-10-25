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

// ১. API Key লোড করা
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

// ২. TechXZone লাইভ প্রোডাক্ট ক্যাটালগ আনা
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

// ৩. Gemini 3.5 Flash সেলস এক্সিকিউটিভ ইঞ্জিন
async function generateAiReply(userPhone, userMessage) {
  if (!currentApiKey || !genAI) {
    return "আসসালামু আলাইকুম ভাইয়া! আমাদের ড্যাশবোর্ডে এখনও Gemini API Key সেভ করা হয়নি। অনুগ্রহ করে ড্যাশবোর্ডে গিয়ে Key সেভ করুন।";
  }

  const systemInstruction = `
তুমি TechXZone (techxzone.shop) এর প্রধান কাস্টমার কেয়ার ও সেলস এক্সিকিউটিভ (বাস্তব মানুষ)। তোমার নাম TechXZone সাপোর্ট টিম।

তোমার বৈশিষ্ট্য ও আচরণ:
১. মানুষের মতো আন্তরিকতা ও আবেগ: একদম রক্ত-মাংসের আন্তরিক সেলস প্রতিনিধির মতো কথা বলবে। কাস্টমারকে সম্মান দিয়ে "ভাইয়া" বা "স্যার" বলে ডাকবে। কখনোই বলবে না তুমি বট বা রোবট।
২. প্রোডাক্টের বিবরণ ও দাম: কাস্টমার যা জানতে চাইবে (যেমন: ফ্যান, ইউপিএস, ব্যাটারি), নিচে দেওয়া ক্যাটালগ দেখে সঠিক নাম, সঠিক দাম ও সরাসরি কেনার লিংক (buy_link) সুন্দর করে বুঝিয়ে দেবে।
৩. ক্যাশ অন ডেলিভারি: মনে করিয়ে দেবে সারা বাংলাদেশে ১০০% ক্যাশ অন ডেলিভারি (Cash on Delivery) সুবিধা রয়েছে (পার্সেল হাতে পেয়ে দেখে টাকা দেওয়ার সুযোগ)।
৪. ভুল হলে ক্ষমা চাওয়া: কাস্টমারের কোনো কথা বুঝতে ভুল হলে সাথে সাথে আন্তরিকভাবে ক্ষমা চেয়ে নেবে ("দুঃখিত ভাইয়া, বুঝতে একটু ভুল হয়েছিল...", "ক্ষমা সুন্দর দৃষ্টিতে দেখবেন ভাইয়া")।
৫. স্টকে না থাকলে: বিনয়ের সাথে জানাবে দ্রুত স্টকে আসবে এবং বিকল্প কোনো ভালো প্রোডাক্ট সাজেস্ট করবে।
৬. ভাষা: কাস্টমার যেভাবে লিখবে (বাংলা বা বাংলিশ), তুমি মিষ্টি ও প্রফেশনাল ভাষায় উত্তর দেবে।

TechXZone এর লাইভ প্রোডাক্ট ক্যাটালগ:
${JSON.stringify(productCatalog, null, 2)}
  `;

  // Gemini 3.5 Flash মডেল কল (অটো-ফলব্যাক সহ)
  const modelsToTry = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-1.5-flash"];

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction
      });

      let history = conversationHistory.get(userPhone) || [];

      const chat = model.startChat({
        history: history.slice(-6)
      });

      const result = await chat.sendMessage(userMessage);
      const replyText = result.response.text();

      history.push({ role: "user", parts: [{ text: userMessage }] });
      history.push({ role: "model", parts: [{ text: replyText }] });
      conversationHistory.set(userPhone, history);

      return replyText;
    } catch (err) {
      console.warn(`[Gemini] ${modelName} ফেইল করেছে, পরের মডেলে চেষ্টা করা হচ্ছে... এরর:`, err.message);
    }
  }

  return "আন্তরিকভাবে দুঃখিত ভাইয়া! সার্ভার থেকে উত্তর তৈরিতে একটু সমস্যা হয়েছে। আপনি কি দয়া করে কিছুক্ষণ পর আবার মেসেজ দেবেন? অথবা সরাসরি কল করতে পারেন: 01771049068।";
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
      console.log('🎉 [TechXZone WhatsApp Bot] কানেক্টেড আছে!');
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

    console.log(`[কাস্টমার মেসেজ]: ${text}`);

    const aiReply = await generateAiReply(sender, text);
    await sock.sendMessage(sender, { text: aiReply });
  });
}

// ৫. ওয়েব ড্যাশবোর্ড
app.get('/', (req, res) => {
  const keyStatus = currentApiKey ? `<span style="color:#059669;font-weight:bold;">সক্রিয় আছে ✅ (Gemini 3.5 Flash)</span>` : `<span style="color:#dc2626;font-weight:bold;">❌ কোনো Key দেওয়া নেই!</span>`;

  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TechXZone WhatsApp AI - Gemini 3.5 Flash</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #1e293b; padding: 20px; }
        .card { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 24px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; }
        input[type="text"] { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 12px; border: 1.5px solid #cbd5e1; font-size: 15px; margin-top: 6px; outline: none; }
        button { width: 100%; background: #059669; color: #fff; border: none; padding: 12px; border-radius: 12px; font-weight: bold; font-size: 15px; cursor: pointer; margin-top: 10px; }
        .btn-danger { background: #dc2626 !important; }
        .code-box { background: #ecfdf5; border: 2px dashed #059669; border-radius: 16px; padding: 18px; text-align: center; margin: 15px 0; }
        .code-text { font-size: 32px; font-weight: 900; letter-spacing: 5px; color: #047857; font-family: monospace; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="margin:0 0 6px;text-align:center;color:#0f172a;">TechXZone WhatsApp AI</h2>
        <p style="text-align:center;color:#64748b;font-size:13px;margin:0 0 20px;">Powered by <b>Gemini 3.5 Flash</b></p>

        <!-- WhatsApp স্ট্যাটাস -->
        <div style="background:#f1f5f9;padding:18px;border-radius:18px;margin-bottom:20px;">
          ${isConnected 
            ? `<div style="color:#059669;font-weight:bold;font-size:18px;text-align:center;">✅ WhatsApp সফলভাবে কানেক্টেড!</div>
               <p style="margin:6px 0 0;font-size:13px;color:#64748b;text-align:center;">বট লাইভ উত্তর দিচ্ছে।</p>`
            : (pairingCode 
                ? `<div class="code-box">
                    <p style="margin:0 0 8px;font-size:13px;color:#065f46;font-weight:bold;">আপনার Pairing Code:</p>
                    <div class="code-text">${pairingCode}</div>
                   </div>
                   <form action="/reset-pairing" method="POST">
                     <button type="submit" class="btn-danger">🔄 নম্বর পরিবর্তন করুন</button>
                   </form>`
                : `<form action="/get-code" method="POST">
                    <label style="font-size:13px;font-weight:bold;color:#334155;">WhatsApp নম্বর দিন:</label>
                    <input type="text" name="phone" placeholder="যেমন: 01771049068" required />
                    <button type="submit">📲 Get Pairing Code</button>
                   </form>`
              )
          }
        </div>

        <!-- Gemini API Key -->
        <div style="border-top:1px solid #e2e8f0;padding-top:16px;">
          <div style="font-size:13px;margin-bottom:8px;">AI স্ট্যাটাস: ${keyStatus}</div>
          <form action="/save-key" method="POST">
            <label style="font-size:12px;font-weight:bold;color:#475569;">Gemini API Key সেট করুন:</label>
            <input type="text" name="apiKey" placeholder="AIzaSy... কি পেস্ট করুন" value="${currentApiKey ? currentApiKey.substring(0, 8) + '...' + currentApiKey.slice(-4) : ''}" required />
            <button type="submit" style="background:#0f172a;">💾 Save API Key</button>
          </form>
          <p style="font-size:11px;color:#64748b;margin-top:8px;text-align:center;">
            Google AI Studio (aistudio.google.com) থেকে ফ্রি Key এনে এখানে সেভ করবেন।
          </p>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ৬. পেয়ারিং কোড রিকোয়েস্ট
app.post('/get-code', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.redirect('/');

  if (phone.length === 11 && phone.startsWith('01')) {
    phone = '88' + phone;
  }

  try {
    if (sock && !sock.authState.creds.registered) {
      await delay(2000);
      const code = await sock.requestPairingCode(phone);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
      setTimeout(() => { pairingCode = null; }, 120000);
    }
  } catch (err) {
    console.error("[WhatsApp] এরর:", err.message);
  }

  res.redirect('/');
});

// ৭. রিসেট
app.post('/reset-pairing', async (req, res) => {
  pairingCode = null;
  try {
    if (fs.existsSync('txz_auth_session')) {
      fs.rmSync('txz_auth_session', { recursive: true, force: true });
    }
  } catch (e) {}

  if (sock) {
    try { sock.end(undefined); } catch (e) {}
  }
  await initWhatsApp();
  res.redirect('/');
});

// ৮. Key সেভ
app.post('/save-key', (req, res) => {
  const newKey = (req.body.apiKey || '').trim();
  if (newKey) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ apiKey: newKey }, null, 2));
    currentApiKey = newKey;
    genAI = new GoogleGenerativeAI(currentApiKey);
    console.log("🎉 Gemini 3.5 Flash API Key সক্রিয় হয়েছে!");
  }
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initWhatsApp();
});
