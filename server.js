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

// ১. Gemini API Key
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
let compactCatalogText = "";
const conversationHistory = new Map();
const userMessageBuffers = new Map(); // পর পর দ্রুত মেসেজ আসলে একত্র করার বাফার

// ২. TechXZone ক্যাটালগ
async function updateCatalog() {
  try {
    const res = await axios.get('https://techxzone.shop/api.php?action=bot_catalog', { timeout: 8000 });
    if (res.data && res.data.products) {
      productCatalog = res.data.products;
      compactCatalogText = productCatalog.map(p => 
        `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | স্টক: ${p.in_stock} | লিংক: ${p.buy_link}`
      ).join('\n');
      console.log(`[TechXZone] মোট ${productCatalog.length} টি প্রোডাক্ট সিঙ্ক হয়েছে।`);
    }
  } catch (err) {
    console.error("[TechXZone] ক্যাটালগ এরর:", err.message);
  }
}
updateCatalog();
setInterval(updateCatalog, 15 * 60 * 1000);

// ৩. সরাসরি techxzone.shop-এ অর্ডার তৈরি
async function createWebsiteOrder(orderInfo) {
  try {
    const orderId = `TXZ-${Math.floor(1000 + Math.random() * 9000)}`;
    const courierFee = (orderInfo.address && (orderInfo.address.toLowerCase().includes('dhaka') || orderInfo.address.includes('ঢাকা'))) ? 60 : 120;
    const subtotal = Number(orderInfo.price || 0) * Number(orderInfo.qty || 1);
    const grandTotal = subtotal + courierFee;

    const payload = {
      orderId: orderId,
      customerName: orderInfo.name || "WhatsApp Customer",
      phone: orderInfo.phone,
      division: "ঢাকা বিভাগ",
      district: "ঢাকা",
      upazila: "",
      address: orderInfo.address,
      customerNote: `WhatsApp Bot Direct Order (${orderInfo.product_name})`,
      paymentMethod: "Cash on Delivery",
      items: [{
        id: orderInfo.product_id || 1,
        title: orderInfo.product_name,
        price: Number(orderInfo.price || 0),
        qty: Number(orderInfo.qty || 1)
      }],
      subtotal: subtotal,
      discount: 0,
      courierFee: courierFee,
      advanceFee: 0,
      codDue: grandTotal,
      grandTotal: grandTotal,
      status: "Pending"
    };

    const res = await axios.post('https://techxzone.shop/api.php?action=create_order', payload, { timeout: 10000 });
    if (res.data && res.data.status === 'success') {
      return { success: true, orderId: orderId, grandTotal: grandTotal };
    }
    return { success: false };
  } catch (err) {
    console.error("[Order Error]:", err.message);
    return { success: false };
  }
}

// ৪. শক্তিশালী ও মানবিক AI ইঞ্জিন (কখনো ক্র্যাশ করবে না)
async function generateAiReply(userPhone, userMessage) {
  if (!currentApiKey || !genAI) {
    return "আসসালামু আলাইকুম ভাইয়া! আমাদের AI API Key সেট করা হয়নি। অনুগ্রহ করে ড্যাশবোর্ড থেকে Key সেভ করুন।";
  }

  try {
    const cleanUserPhone = userPhone.replace(/[^0-9]/g, '').slice(-11);

    const systemInstruction = `
তুমি TechXZone (techxzone.shop) এর একজন অত্যন্ত আন্তরিক, বিনয়ী ও বাস্তব সেলস এক্সিকিউটিভ (মানুষ)। তোমার নাম TechXZone সাপোর্ট টিম।

নিয়মাবলী:
১. মানুষের মতো অনুভূতি: রক্ত-মাংসের মানুষের মতো মিষ্টি ও ভদ্র ভাষায় কথা বলবে। কাস্টমারকে "ভাইয়া" সম্বোধন করবে। কখনো বলবে না তুমি এআই বা বট। কোনো ভুল হলে সাথে সাথে আন্তরিকভাবে ক্ষমা চাইবে ("দুঃখিত ভাইয়া, বুঝতে ভুল হয়েছিল...")।
২. প্রোডাক্ট ও দাম: কাস্টমার যে পণ্য খুঁজবে, নিচের তালিকা দেখে তার নাম, সঠিক দাম ও লিংক দেবে।
৩. সরাসরি WhatsApp-এ অর্ডার নেওয়ার নিয়ম:
   - কাস্টমার যদি বলে "অর্ডার কনফার্ম করেন" বা "১ নম্বরটা নিব", কিন্তু নাম ও ঠিকানা দেয়নি—তখন তাকে মিষ্টি করে বলবে: "জি ভাইয়া! আপনার পছন্দের পণ্যটি বুক করতে আপনার ১) নাম, ২) সম্পূর্ণ ডেলিভারি ঠিকানা (জেলা সহ) লিখে পাঠিয়ে দিন।"
   - কাস্টমার যখন পণ্যের নাম এবং তার ঠিকানা দেবে, তখন উত্তরের শেষে এই গোপন কোডটি বসিয়ে দেবে:
   [[ORDER:{"product_id":ID,"product_name":"পণ্যের নাম","price":দাম,"qty":১,"name":"গ্রাহকের নাম","phone":"${cleanUserPhone}","address":"গ্রাহকের ঠিকানা"}]]

ক্যাটালগ:
${compactCatalogText || 'পণ্য লোড হচ্ছে...'}
    `;

    // মডেল নির্বাচন (1.5-flash বা 2.0-flash)
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: systemInstruction,
      generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
    });

    // চ্যাট হিস্ট্রি যাতে ক্র্যাশ না করে সেজন্য ক্লিন ফিল্টার
    let rawHistory = conversationHistory.get(userPhone) || [];
    let cleanHistory = [];
    for (let i = 0; i < rawHistory.length; i++) {
      if (cleanHistory.length === 0 || cleanHistory[cleanHistory.length - 1].role !== rawHistory[i].role) {
        cleanHistory.push(rawHistory[i]);
      }
    }

    const chat = model.startChat({
      history: cleanHistory.slice(-4)
    });

    const result = await chat.sendMessage(userMessage);
    let replyText = result.response.text();

    // অর্ডার প্লেসমেন্ট হ্যান্ডলার
    const orderMatch = replyText.match(/\[\[ORDER:(.*?)\]\]/);
    if (orderMatch && orderMatch[1]) {
      try {
        const orderData = JSON.parse(orderMatch[1]);
        if (!orderData.phone) orderData.phone = cleanUserPhone;

        const orderResult = await createWebsiteOrder(orderData);
        if (orderResult.success) {
          const invoiceNote = `\n\n🎉 *আলহামদুলিল্লাহ ভাইয়া! আপনার অর্ডারটি কনফার্ম করা হয়েছে।* \n🆔 *অর্ডার আইডি:* #${orderResult.orderId}\n📦 *পণ্য:* ${orderData.product_name}\n💰 *সর্বমোট বিল:* ৳${orderResult.grandTotal.toLocaleString()} (ক্যাশ অন ডেলিভারি)\n🚚 পার্সেল পৌঁছে দিলে দেখে মূল্য পরিশোধ করবেন। ধন্যবাদ TechXZone এর সাথে থাকার জন্য! ❤️`;
          replyText = replyText.replace(/\[\[ORDER:(.*?)\]\]/, '') + invoiceNote;
        }
      } catch (err) {
        replyText = replyText.replace(/\[\[ORDER:(.*?)\]\]/, '');
      }
    }

    cleanHistory.push({ role: "user", parts: [{ text: userMessage }] });
    cleanHistory.push({ role: "model", parts: [{ text: replyText }] });
    conversationHistory.set(userPhone, cleanHistory);

    return replyText;
  } catch (error) {
    console.error("Gemini Error:", error.message);
    return "জি ভাইয়া, আমি বুঝতে পেরেছি! আপনার পছন্দের প্রোডাক্টটি কনফার্ম করতে অনুগ্রহ করে আপনার নাম ও সম্পূর্ণ ঠিকানা (জেলা সহ) লিখে পাঠিয়ে দিন।";
  }
}

// ৫. WhatsApp Baileys ইঞ্জিন (অটো রিকানেক্ট ও সেফটি সহ)
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

  // পর পর দ্রুত মেসেজ আসলে বাফার করে একত্রে উত্তর দেওয়ার সিস্টেম
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const sender = msg.key.remoteJid;
      if (sender.includes('@g.us')) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!text) return;

      console.log(`[কাস্টমার]: ${text}`);

      // বাফারে মেসেজ জমা রাখা (পরপর ৩-৪টা মেসেজ দিলেও সবগুলোকে জোড়া লাগানো)
      let currentBuffer = userMessageBuffers.get(sender) || [];
      currentBuffer.push(text);
      userMessageBuffers.set(sender, currentBuffer);

      // ২ সেকেন্ড অপেক্ষা করবে কাস্টমার আরও কিছু লেখে কিনা দেখতে
      setTimeout(async () => {
        const bufferedMsgs = userMessageBuffers.get(sender);
        if (!bufferedMsgs || bufferedMsgs.length === 0) return;

        userMessageBuffers.delete(sender);
        const combinedMessage = bufferedMsgs.join(' ');

        const aiReply = await generateAiReply(sender, combinedMessage);
        await sock.sendMessage(sender, { text: aiReply });
      }, 2000);

    } catch (err) {
      console.error("[Message Upsert Error]:", err.message);
    }
  });
}

// ৬. ড্যাশবোর্ড
app.get('/', (req, res) => {
  const keyStatus = currentApiKey ? `<span style="color:#059669;font-weight:bold;">সক্রিয় আছে ✅</span>` : `<span style="color:#dc2626;font-weight:bold;">❌ Key দেওয়া নেই!</span>`;

  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TechXZone WhatsApp Bot</title>
      <style>
        body { font-family: sans-serif; background: #f8fafc; color: #1e293b; padding: 20px; }
        .card { max-width: 480px; margin: 0 auto; background: #fff; border-radius: 24px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; }
        input[type="text"] { width: 100%; box-sizing: border-box; padding: 12px; border-radius: 12px; border: 1.5px solid #cbd5e1; font-size: 15px; margin-top: 6px; outline: none; }
        button { width: 100%; background: #059669; color: #fff; border: none; padding: 12px; border-radius: 12px; font-weight: bold; font-size: 15px; cursor: pointer; margin-top: 10px; }
        .code-box { background: #ecfdf5; border: 2px dashed #059669; border-radius: 16px; padding: 18px; text-align: center; margin: 15px 0; }
        .code-text { font-size: 32px; font-weight: 900; letter-spacing: 5px; color: #047857; font-family: monospace; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2 style="margin:0 0 6px;text-align:center;">TechXZone WhatsApp AI</h2>
        <p style="text-align:center;color:#64748b;font-size:13px;margin:0 0 20px;">Fast Response & Auto Order</p>

        <div style="background:#f1f5f9;padding:18px;border-radius:18px;margin-bottom:20px;text-align:center;">
          ${isConnected 
            ? `<div style="color:#059669;font-weight:bold;font-size:18px;">✅ WhatsApp সফলভাবে লাইভ আছে!</div>
               <p style="margin:6px 0 0;font-size:12px;color:#64748b;">বট কাস্টমারদের সাথে দ্রুত কথা বলছে ও সরাসরি অর্ডার নিচ্ছে।</p>`
            : (pairingCode 
                ? `<div class="code-box">
                    <p style="margin:0 0 8px;font-size:13px;color:#065f46;font-weight:bold;">Pairing Code:</p>
                    <div class="code-text">${pairingCode}</div>
                   </div>`
                : `<form action="/get-code" method="POST">
                    <input type="text" name="phone" placeholder="WhatsApp নম্বর দিন (017...)" required />
                    <button type="submit">📲 Get Pairing Code</button>
                   </form>`
              )
          }
        </div>

        <div style="border-top:1px solid #e2e8f0;padding-top:16px;">
          <div style="font-size:13px;margin-bottom:8px;">AI স্ট্যাটাস: ${keyStatus}</div>
          <form action="/save-key" method="POST">
            <input type="text" name="apiKey" placeholder="Gemini API Key দিন..." value="${currentApiKey ? currentApiKey.substring(0, 8) + '...' : ''}" required />
            <button type="submit" style="background:#0f172a;">💾 Save API Key</button>
          </form>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ৭. পেয়ারিং কোড
app.post('/get-code', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.redirect('/');
  if (phone.length === 11 && phone.startsWith('01')) phone = '88' + phone;

  try {
    if (sock && !sock.authState.creds.registered) {
      await delay(2000);
      const code = await sock.requestPairingCode(phone);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
      setTimeout(() => { pairingCode = null; }, 120000);
    }
  } catch (err) {}
  res.redirect('/');
});

// ৮. Key সেভ
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
