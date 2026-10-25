const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err.message));

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SESSION_DIR = path.join(__dirname, 'txz_auth_session');
const CATALOG_CACHE_FILE = path.join(__dirname, 'catalog_cache.json');

// অ্যাডমিনের WhatsApp নম্বর
const ADMIN_PHONE = process.env.ADMIN_PHONE || "8801404277094"; 

// 📋 প্রিমিয়াম বোল্ড করা WhatsApp অর্ডার ফর্ম (সম্পূর্ণ আলাদা মেসেজ হিসেবে যাবে)
const ORDER_FORM_TEXT = `📋 *ক্যাশ অন ডেলিভারি অর্ডার ফর্ম*
━━━━━━━━━━━━━━━━━━━━

*১. আপনার পুরো নাম :* 

*২. মোবাইল নম্বর :* 

*৩. সম্পূর্ণ ঠিকানা (বাসা/রোড/এলাকা) :* 

*৪. জেলা ও থানা :* 

*৫. পণ্যের নাম ও সংখ্যা :* 

━━━━━━━━━━━━━━━━━━━━`;

// ১. Gemini API Key
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
let genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

let isConnected = false;
let pairingCode = null;
let qrCodeData = null;
let lastEnteredPhone = "";
let pairingErrorMessage = "";
let sock = null;
let productCatalog = [];
const conversationHistory = new Map();
let backupTimer = null;

// মেমোরি লিক ফিক্স
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of conversationHistory.entries()) {
    if (data.lastUpdated && now - data.lastUpdated > 24 * 60 * 60 * 1000) {
      conversationHistory.delete(phone);
    }
  }
}, 60 * 60 * 1000);

// ২. সম্পূর্ণ WhatsApp সেশন ডেটাবেজে ব্যাকআপ ও রিস্টোর
async function restoreFullSession() {
  try {
    const res = await axios.get('https://techxzone.shop/api.php?action=get_settings&key=wa_full_session_bundle', { timeout: 10000 });
    const bundle = res.data;
    if (bundle && typeof bundle === 'object' && bundle['creds.json']) {
      await fsPromises.mkdir(SESSION_DIR, { recursive: true });
      for (const [filename, content] of Object.entries(bundle)) {
        await fsPromises.writeFile(
          path.join(SESSION_DIR, filename), 
          typeof content === 'string' ? content : JSON.stringify(content)
        );
      }
      console.log(`✅ [TechXZone] ডেটাবেজ থেকে সেশন রিস্টোর হয়েছে!`);
      return true;
    }
  } catch (e) {}
  return false;
}

function scheduleSessionBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      if (!fs.existsSync(SESSION_DIR)) return;
      const files = await fsPromises.readdir(SESSION_DIR);
      if (files.length === 0 || !files.includes('creds.json')) return;

      const sessionBundle = {};
      for (const file of files) {
        const fullPath = path.join(SESSION_DIR, file);
        const stat = await fsPromises.stat(fullPath);
        if (stat.isFile()) {
          sessionBundle[file] = await fsPromises.readFile(fullPath, 'utf-8');
        }
      }

      await axios.post('https://techxzone.shop/api.php?action=save_settings', {
        key: 'wa_full_session_bundle',
        data: sessionBundle
      }, { timeout: 10000 });
      console.log(`💾 [TechXZone] সেশন ফাইল ডেটাবেজে সেভ হয়েছে!`);
    } catch (e) {}
  }, 4000);
}

// ৩. লাইভ ক্যাটালগ
async function updateCatalog() {
  try {
    const res = await axios.get('https://techxzone.shop/api.php?action=bot_catalog', { timeout: 8000 });
    if (res.data && res.data.products) {
      productCatalog = res.data.products;
      console.log(`[TechXZone] মোট ${productCatalog.length} টি প্রোডাক্ট সিঙ্ক হয়েছে।`);
      await fsPromises.writeFile(CATALOG_CACHE_FILE, JSON.stringify(productCatalog)).catch(() => {});
      return true;
    }
  } catch (err) {
    try {
      if (fs.existsSync(CATALOG_CACHE_FILE)) {
        const cached = await fsPromises.readFile(CATALOG_CACHE_FILE, 'utf-8');
        productCatalog = JSON.parse(cached);
        console.log(`[TechXZone] লোকাল ক্যাশ থেকে ${productCatalog.length} টি প্রোডাক্ট লোড হয়েছে।`);
      }
    } catch (e) {}
  }
  return false;
}
updateCatalog();
setInterval(updateCatalog, 15 * 60 * 1000);

// ৪. স্মার্ট ক্যাটালগ ফিল্টারিং
function getSmartCatalog(userQuery) {
  if (!productCatalog.length) return "পণ্য লোড হচ্ছে...";
  const q = (userQuery || "").toLowerCase();
  
  let filtered = productCatalog.filter(p => {
    const name = (p.name || "").toLowerCase();
    const cat = (p.category || "").toLowerCase();
    return q.split(" ").some(word => word.length > 2 && (name.includes(word) || cat.includes(word)));
  });

  if (!filtered.length) {
    filtered = productCatalog.slice(0, 15);
  }

  return filtered.slice(0, 15).map(p => 
    `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | স্টক: ${p.in_stock} | লিংক: ${p.buy_link}`
  ).join('\n');
}

// ৫. সাইটে সরাসরি অর্ডার বুকিং
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
      if (sock && isConnected) {
        const adminJid = `${ADMIN_PHONE.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        const adminMsg = `🚨 *নতুন অর্ডার বুক হয়েছে!*\n━━━━━━━━━━━━━━━━━━━━\n🆔 অর্ডার আইডি: #${orderId}\n📦 পণ্য: ${orderInfo.product_name}\n👤 কাস্টমার: ${orderInfo.name}\n📞 মোবাইল: ${orderInfo.phone}\n📍 ঠিকানা: ${orderInfo.address}\n💰 মোট বিল: ৳${grandTotal.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━`;
        sock.sendMessage(adminJid, { text: adminMsg }).catch(() => {});
      }
      return { success: true, orderId: orderId, grandTotal: grandTotal };
    }
    return { success: false };
  } catch (err) {
    return { success: false };
  }
}

// ৬. মানবিক এআই ইঞ্জিন (নির্দেশনায় ফর্ম ট্যাগ যুক্ত)
async function generateAiReply(userPhone, userMessage) {
  if (!genAI || !GEMINI_API_KEY) {
    return "আসসালামু আলাইকুম ভাইয়া! Render ড্যাশবোর্ডে GEMINI_API_KEY সেট করুন।";
  }

  const cleanUserPhone = userPhone.replace(/[^0-9]/g, '').slice(-11);
  const relevantCatalog = getSmartCatalog(userMessage);

  const systemInstruction = `
তুমি TechXZone (techxzone.shop) এর প্রধান সেলস এক্সিকিউটিভ (বাস্তব মানুষ)। তোমার নাম TechXZone সাপোর্ট টিম।

আচরণ ও নিয়মানুযায়ী কথা বলার ধরন:
১. মানুষের মতো অনুভূতি: রক্ত-মাংসের মানুষের মতো মিষ্টি ও আন্তরিক ভাষায় কথা বলবে। কাস্টমারকে "ভাইয়া" সম্বোধন করবে। কোনো অবস্থাতেই বলবে না তুমি এআই বা রোবট।
২. প্রোডাক্ট ও দাম: কাস্টমার যা খুঁজবে, তালিকা দেখে সঠিক নাম, দাম ও সরাসরি অর্ডার লিংক (buy_link) দিয়ে দেবে।
৩. ক্যাশ অন ডেলিভারি: মনে করিয়ে দেবে সারা দেশে ১০০% ক্যাশ অন ডেলিভারিতে পার্সেল চেক করে টাকা দেওয়ার সুবিধা আছে।

৪. 📋 অর্ডার ফর্ম পাঠানোর নিয়ম (খুব গুরুত্বপূর্ণ):
   - কাস্টমার যদি পণ্য নিতে চায়, বা বলে "অর্ডার করব", "অর্ডার কনফার্ম করেন", "১ নম্বরটা নিব", কিন্তু নাম ও সম্পূর্ণ ঠিকানা দেয়নি—তখন তোমার উত্তরে অবশ্যই শুরুতে \`[[SEND_FORM]]\` ট্যাগটি দিয়ে দেবে।
   - তুমি উত্তরের ভেতরে কোনো ফর্ম টাইপ করবে না! সিস্টেম নিজে থেকে প্রিমিয়াম ফর্ম পাঠিয়ে দেবে।
   - তুমি শুধু কাস্টমারকে মিষ্টি করে বলবে: "দারুণ ভাইয়া! অর্ডারটি কনফার্ম করতে অনুগ্রহ করে উপরের ফর্মটি কপি করে আপনার নাম ও ঠিকানা লিখে পাঠিয়ে দিন। সারা দেশে পার্সেল হাতে পেয়ে দেখে টাকা দিতে পারবেন।"

৫. সরাসরি অর্ডার বুকিং:
   - কাস্টমার যখন নাম ও ঠিকানা পাঠিয়ে দেবে, তখন তার অর্ডারটি ওয়েবসাইটে বুক করার জন্য উত্তরের একদম শেষে এই কোডটি দেবে:
   [[ORDER:{"product_id":ID,"product_name":"নাম","price":দাম,"qty":১,"name":"নাম","phone":"মোবাইল নম্বর","address":"ঠিকানা"}]]

প্রাসঙ্গিক প্রোডাক্ট তালিকা:
${relevantCatalog}
  `;

  const modelsToTry = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-1.5-flash"];

  const storedEntry = conversationHistory.get(userPhone);
  let rawHistory = storedEntry?.history || [];
  let cleanHistory = [];
  for (let i = 0; i < rawHistory.length; i++) {
    if (cleanHistory.length === 0) {
      if (rawHistory[i].role === 'user') cleanHistory.push(rawHistory[i]);
    } else if (cleanHistory[cleanHistory.length - 1].role !== rawHistory[i].role) {
      cleanHistory.push(rawHistory[i]);
    }
  }

  for (const modelName of modelsToTry) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemInstruction,
        generationConfig: { maxOutputTokens: 600, temperature: 0.6 }
      });

      let replyText = "";

      if (cleanHistory.length > 0) {
        const chat = model.startChat({ history: cleanHistory.slice(-4) });
        const result = await chat.sendMessage(userMessage);
        replyText = result.response.text();
      } else {
        const result = await model.generateContent(userMessage);
        replyText = result.response.text();
      }

      const orderMatch = replyText.match(/\[\[ORDER:(.*?)\]\]/);
      if (orderMatch && orderMatch[1]) {
        try {
          const orderData = JSON.parse(orderMatch[1]);
          if (!orderData.phone || orderData.phone.length < 10) orderData.phone = cleanUserPhone;

          const orderResult = await createWebsiteOrder(orderData);
          if (orderResult.success) {
            const invoiceNote = `\n\n🎉 *আলহামদুলিল্লাহ ভাইয়া! আপনার অর্ডারটি সফলভাবে কনফার্ম করা হয়েছে।* \n🆔 *অর্ডার আইডি:* #${orderResult.orderId}\n📦 *পণ্য:* ${orderData.product_name}\n💰 *সর্বমোট বিল:* ৳${orderResult.grandTotal.toLocaleString()} (ক্যাশ অন ডেলিভারি)\n🚚 পার্সেল পৌঁছে দিলে দেখে মূল্য পরিশোধ করবেন। ধন্যবাদ TechXZone এর সাথে থাকার জন্য! ❤️`;
            replyText = replyText.replace(/\[\[ORDER:(.*?)\]\]/, '') + invoiceNote;
          }
        } catch (err) {
          replyText = replyText.replace(/\[\[ORDER:(.*?)\]\]/, '');
        }
      }

      cleanHistory.push({ role: "user", parts: [{ text: userMessage }] });
      cleanHistory.push({ role: "model", parts: [{ text: replyText }] });
      conversationHistory.set(userPhone, { history: cleanHistory, lastUpdated: Date.now() });

      return replyText;
    } catch (err) {}
  }

  return "জি ভাইয়া! TechXZone-এ আপনাকে স্বাগতম। আপনি কোন প্রোডাক্টটি দেখতে চাচ্ছেন একটু জানাবেন কি?";
}

// ৭. WhatsApp Baileys ইঞ্জিন (ফর্ম সম্পূর্ণ আলাদা মেসেজে ডেলিভারি করার লজিক)
async function initWhatsApp() {
  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined);
      } catch (e) {}
    }

    await restoreFullSession();

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        QRCode.toDataURL(qr, (err, url) => {
          if (!err) qrCodeData = url;
        });
      }

      if (connection === 'close') {
        isConnected = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(initWhatsApp, 3000);
        } else {
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
        }
      } else if (connection === 'open') {
        isConnected = true;
        pairingCode = null;
        qrCodeData = null;
        pairingErrorMessage = "";
        console.log('🎉 [TechXZone WhatsApp Bot] সফলভাবে কানেক্টেড আছে!');
        scheduleSessionBackup();
      }
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      scheduleSessionBackup();
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      try {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const msgTimestamp = Number(msg.messageTimestamp || 0);
        const currentTimestamp = Math.floor(Date.now() / 1000);
        if (msgTimestamp && (currentTimestamp - msgTimestamp > 60)) return;

        const sender = msg.key.remoteJid;
        if (sender.includes('@g.us')) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text) return;

        console.log(`[কাস্টমার]: ${text}`);

        try {
          await sock.readMessages([msg.key]);
          await sock.presenceSubscribe(sender);
          await sock.sendPresenceUpdate('composing', sender);
        } catch (e) {}

        const aiReply = await generateAiReply(sender, text);

        // 🚀 ফর্ম আলাদা মেসেজ হিসেবে পাঠানোর গ্যারান্টিযুক্ত সিস্টেম
        const isFormRequested = aiReply.includes('[[SEND_FORM]]') || aiReply.includes('ক্যাশ অন ডেলিভারি অর্ডার ফর্ম');

        if (isFormRequested) {
          // ১. ১ম মেসেজে শুধুমাত্র পিওর বোল্ড করা ফাঁকা ফর্মটি যাবে
          await sock.sendMessage(sender, { text: ORDER_FORM_TEXT });
          
          await delay(1000); // ১ সেকেন্ড বিরতি

          // ২. এআই-এর বাকি কথাগুলো ফিল্টার করে ২য় মেসেজ হিসেবে যাবে
          let instructionText = aiReply
            .replace(/\[\[SEND_FORM\]\]/g, '')
            .replace(/📋[\s\S]*?━━━━━━━━━━━━━━━━━━━━/g, '') // এআই কোনো ভুল ফর্ম লিখলে তা বাদ দেওয়া
            .replace(/\[\[ORDER:(.*?)\]\]/g, '')
            .trim();

          if (instructionText) {
            await sock.sendMessage(sender, { text: instructionText });
          }
        } else {
          // সাধারণ কথা হলে সরাসরি পাঠিয়ে দেবে
          await sock.sendMessage(sender, { text: aiReply });
        }
        
        try {
          await sock.sendPresenceUpdate('paused', sender);
        } catch (e) {}

      } catch (err) {}
    });

  } catch (err) {
    console.error("WhatsApp Init Error:", err.message);
  }
}

// ৮. অটো পিংগার
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }, 4 * 60 * 1000);
}

// ৯. ড্যাশবোর্ড
app.get('/', (req, res) => {
  const cleanCodeNoDash = pairingCode ? pairingCode.replace(/[^A-Za-z0-9]/g, '') : '';

  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TechXZone Ultra-Fast Bot</title>
      <style>
        body { font-family: sans-serif; background: #f1f5f9; color: #0f172a; padding: 15px; margin: 0; }
        .card { max-width: 440px; margin: 20px auto; background: #fff; border-radius: 24px; padding: 22px; box-shadow: 0 10px 25px rgba(0,0,0,0.07); border: 1px solid #e2e8f0; }
        input[type="text"] { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 14px; border: 1.5px solid #cbd5e1; font-size: 15px; margin-top: 8px; outline: none; }
        .btn { width: 100%; border: none; padding: 13px; border-radius: 14px; font-weight: bold; font-size: 14px; cursor: pointer; margin-top: 10px; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .btn-green { background: #059669; color: #fff; }
        .btn-blue { background: #2563eb; color: #fff; }
        .btn-copy { background: #0284c7; color: #fff; }
        .btn-gray { background: #e2e8f0; color: #334155; }
        .btn-danger { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; font-size: 12px; }
        .code-box { background: #ecfdf5; border: 2px dashed #059669; border-radius: 18px; padding: 16px; text-align: center; margin: 12px 0; }
        .code-text { font-size: 34px; font-weight: 900; letter-spacing: 5px; color: #047857; font-family: monospace; }
        .badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; margin-bottom: 12px; }
      </style>
      <script>
        function copyCodeToClipboard() {
          const code = "${cleanCodeNoDash}";
          navigator.clipboard.writeText(code).then(() => {
            const btn = document.getElementById('copyBtn');
            btn.innerHTML = "✅ কপি হয়েছে!";
            btn.style.background = "#10b981";
            setTimeout(() => {
              btn.innerHTML = "📋 কোডটি কপি করুন (Copy)";
              btn.style.background = "#0284c7";
            }, 2500);
          });
        }
      </script>
    </head>
    <body>
      <div class="card">
        <h2 style="margin:0 0 4px;text-align:center;font-size:20px;">TechXZone WhatsApp Bot</h2>
        <p style="text-align:center;color:#64748b;font-size:12px;margin:0 0 10px;">Real-Time Fast Speed & Live Typing</p>
        <div style="text-align:center;">
          <span class="badge">📦 মোট প্রোডাক্ট সিঙ্ক: ${productCatalog.length} টি</span>
        </div>

        ${isConnected 
          ? `<div style="background:#ecfdf5;border:2px solid #a7f3d0;padding:20px;border-radius:18px;text-align:center;">
              <div style="color:#059669;font-weight:900;font-size:18px;">✅ WhatsApp সফলভাবে লাইভ আছে!</div>
              <p style="margin:8px 0 15px;font-size:13px;color:#475569;">বট বিদ্যুৎগতিতে লাইভ টাইপিং দিয়ে উত্তর দিচ্ছে।</p>
              
              <form action="/refresh-catalog" method="POST" style="margin-bottom:8px;">
                <button type="submit" class="btn btn-blue">🔄 ক্যাটালগ রিফ্রেশ করুন</button>
              </form>

              <form action="/hard-reset" method="POST">
                <button type="submit" class="btn btn-danger">লগআউট / ডিসকানেক্ট করুন</button>
              </form>
             </div>`
          : (pairingCode 
              ? `<div>
                  <div class="code-box">
                    <span style="font-size:12px;color:#065f46;font-weight:bold;">আপনার Pairing Code:</span>
                    <div class="code-text">${pairingCode}</div>
                    <span style="font-size:11px;color:#64748b;">নম্বর: <b>${lastEnteredPhone}</b></span>
                  </div>

                  <button type="button" id="copyBtn" onclick="copyCodeToClipboard()" class="btn btn-copy">📋 কোডটি কপি করুন (Copy)</button>

                  <div style="display:flex;gap:8px;margin-top:10px;">
                    <form action="/resend-code" method="POST" style="flex:1;">
                      <button type="submit" class="btn btn-gray" style="margin-top:0;">🔄 আবার পাঠান</button>
                    </form>
                    <form action="/change-number" method="POST" style="flex:1;">
                      <button type="submit" class="btn btn-gray" style="margin-top:0;">✏️ নম্বর পরিবর্তন</button>
                    </form>
                  </div>
                 </div>`
              : `<div>
                  <form action="/get-code" method="POST">
                    <label style="font-size:13px;font-weight:bold;color:#334155;">WhatsApp নম্বর দিন:</label>
                    <input type="text" name="phone" placeholder="যেমন: 01404277094" required autofocus />
                    <button type="submit" class="btn btn-green">📲 কোড নিন (Pairing Code)</button>
                  </form>
                 </div>`
            )
        }
      </div>
    </body>
    </html>
  `);
});

// ১০. পেয়ারিং কোড রিকোয়েস্ট
app.post('/get-code', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.redirect('/');
  if (phone.length === 11 && phone.startsWith('01')) phone = '88' + phone;

  lastEnteredPhone = phone;
  pairingErrorMessage = "";
  pairingCode = null;

  try {
    if (!sock || !sock.ws) {
      await initWhatsApp();
      await delay(2000);
    }

    if (sock && !sock.authState.creds.registered) {
      await delay(1500);
      const code = await sock.requestPairingCode(phone);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    }
  } catch (err) {}
  res.redirect('/');
});

// ১১. কোড রি-সেন্ড
app.post('/resend-code', async (req, res) => {
  if (lastEnteredPhone && sock && !sock.authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(lastEnteredPhone);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    } catch (e) {}
  }
  res.redirect('/');
});

// ১২. নম্বর পরিবর্তন
app.post('/change-number', (req, res) => {
  pairingCode = null;
  res.redirect('/');
});

// ড্যাশবোর্ড থেকে তাৎক্ষণিক ক্যাটালগ সিঙ্ক বাটন
app.post('/refresh-catalog', async (req, res) => {
  await updateCatalog();
  res.redirect('/');
});

// ১৩. হার্ড রিসেট
app.post('/hard-reset', async (req, res) => {
  pairingCode = null;
  lastEnteredPhone = "";
  isConnected = false;

  try {
    if (fs.existsSync(SESSION_DIR)) {
      await fsPromises.rm(SESSION_DIR, { recursive: true, force: true });
    }
  } catch (e) {}

  try {
    await axios.post('https://techxzone.shop/api.php?action=save_settings', {
      key: 'wa_full_session_bundle',
      data: {}
    }, { timeout: 5000 });
  } catch (e) {}

  if (sock) {
    try { 
      sock.ev.removeAllListeners();
      sock.end(undefined); 
    } catch (e) {}
  }

  setTimeout(initWhatsApp, 2000);
  res.redirect('/');
});

// ==========================================
// 🌐 ওয়েবসাইটের AI চ্যাট এন্ডপয়েন্ট
// ==========================================
app.post('/api/ai-chat', async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    const message = req.body.message || req.body.prompt || "";
    const phone = req.body.phone || "01404277094";

    if (!message) {
      return res.json({ success: false, reply: "মেসেজ লিখুন..." });
    }

    const reply = await generateAiReply(phone, message);
    
    // ওয়েবসাইট চ্যাটে সুন্দরভাবে সাজিয়ে দেখানো
    let cleanReply = reply;
    if (reply.includes('[[SEND_FORM]]')) {
      cleanReply = ORDER_FORM_TEXT + "\n\n" + reply.replace(/\[\[SEND_FORM\]\]/g, '').trim();
    }
    return res.json({ success: true, reply: cleanReply });
  } catch (err) {
    return res.json({ success: false, reply: "জি ভাইয়া! একটু কারিগরি সমস্যা হচ্ছে।" });
  }
});

app.options('/api/ai-chat', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  initWhatsApp();
});
