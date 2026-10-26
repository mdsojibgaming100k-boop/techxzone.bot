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
    if (fs.existsSync(SESSION_DIR)) {
      const existing = await fsPromises.readdir(SESSION_DIR);
      if (existing.includes('creds.json')) return true;
    }

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

// অটো লগআউট বন্ধ করতে লাইটওয়েট ব্যাকআপ সিঙ্ক
function scheduleSessionBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      if (!fs.existsSync(SESSION_DIR)) return;
      const files = await fsPromises.readdir(SESSION_DIR);
      if (!files.includes('creds.json')) return;

      const essentialFiles = files.filter(f => 
        f === 'creds.json' || 
        f.startsWith('app-state-sync-key') || 
        f.startsWith('session-')
      );

      const sessionBundle = {};
      for (const file of essentialFiles) {
        const fullPath = path.join(SESSION_DIR, file);
        sessionBundle[file] = await fsPromises.readFile(fullPath, 'utf-8');
      }

      await axios.post('https://techxzone.shop/api.php?action=save_settings', {
        key: 'wa_full_session_bundle',
        data: sessionBundle
      }, { timeout: 8000 });
      console.log(`💾 [TechXZone] সেশন সফলভাবে সিঙ্ক হয়েছে (${essentialFiles.length} ফাইল)`);
    } catch (e) {
      console.error("Session Backup Warning:", e.message);
    }
  }, 3000);
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
      }
    } catch (e) {}
  }
  return false;
}
updateCatalog();
setInterval(updateCatalog, 15 * 60 * 1000);

// ৪. স্মার্ট ক্যাটালগ ফিল্টারিং (দ্রুতগতির জন্য টপ ৬টি পণ্য)
function getSmartCatalog(userQuery) {
  if (!productCatalog.length) return "পণ্য লোড হচ্ছে...";
  const q = (userQuery || "").toLowerCase();
  
  let filtered = productCatalog.filter(p => {
    const name = (p.name || "").toLowerCase();
    const cat = (p.category || "").toLowerCase();
    return q.split(" ").some(word => word.length > 2 && (name.includes(word) || cat.includes(word)));
  });

  if (!filtered.length) {
    filtered = productCatalog.slice(0, 6);
  }

  return filtered.slice(0, 6).map(p => 
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

    const res = await axios.post('https://techxzone.shop/api.php?action=create_order', payload, { timeout: 8000 });
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

// ৬. সুপার-ফাস্ট এআই ইঞ্জিন (হ্যাং-প্রুফ ও ২০ সেকেন্ড নিরাপদ টাইমআউট)
async function generateAiReply(userPhone, userMessage) {
  if (!genAI || !GEMINI_API_KEY) {
    return "আসসালামু আলাইকুম ভাইয়া! Render ড্যাশবোর্ডে GEMINI_API_KEY সেট করুন।";
  }

  let cleanUserPhone = userPhone.replace(/@.*$/, '').replace(/[^0-9]/g, '');
  if (cleanUserPhone.startsWith('880')) {
    cleanUserPhone = '0' + cleanUserPhone.slice(3);
  } else if (cleanUserPhone.startsWith('88') && cleanUserPhone.length === 13) {
    cleanUserPhone = cleanUserPhone.slice(2);
  }

  const relevantCatalog = getSmartCatalog(userMessage);

  const systemInstruction = `
তুমি TechXZone (techxzone.shop) এর প্রধান সিনিয়র সেলস কনসালট্যান্ট। তোমার নাম TechXZone সাপোর্ট।
জরুরি নিয়ম: দ্রুত, আন্তরিক ও মিষ্টি গলায় অল্প কথায় স্পষ্ট উত্তর দেবে। কখনো ডাবল স্টার (**) ব্যবহার করবে না, শুধু হোয়াটসঅ্যাপের সিঙ্গেল স্টার (*) ব্যবহার করবে। কাস্টমারকে আপন ভাইয়ের মতো "ভাইয়া" সম্বোধন করবে।

🧠 অর্ডার ফর্ম দেওয়ার নিয়ম:
- কাস্টমার যদি পণ্য নিয়ে শুধু প্রশ্ন করে, ডেলিভারি চার্জ জানতে চায়—তখন ফর্ম দেবে না! আগে তার প্রশ্নের উত্তর বুঝিয়ে বলবে।
- ফর্ম শুধুমাত্র তখনই দেবে, যখন কাস্টমার একটি নির্দিষ্ট পণ্য ফাইনাল করবে কিন্তু এখনো নাম ও সম্পূর্ণ ঠিকানা দেয়নি:

📋 *ক্যাশ অন ডেলিভারি অর্ডার ফর্ম*
━━━━━━━━━━━━━━━━━━━━

*১. আপনার পুরো নাম :* 

*২. মোবাইল নম্বর :* ${cleanUserPhone}

*৩. সম্পূর্ণ ঠিকানা (বাসা/রোড/এলাকা) :* 

*৪. জেলা ও থানা :* 

*৫. পণ্যের নাম ও সংখ্যা :* [পণ্যের নাম]

━━━━━━━━━━━━━━━━━━━━

🎉 *দারুণ ভাইয়া!* 
💡 *টিপস:* উপরের ফর্মটি চেপে ধরে কপি করে শুধু আপনার নাম ও ঠিকানা বসিয়ে পাঠিয়ে দিন।
🚚 সারা দেশে ১০০% ক্যাশ অন ডেলিভারি (পার্সেল হাতে পেয়ে দেখে মূল্য পরিশোধ করবেন)।

অর্ডার কনফার্ম কোড:
[[ORDER:{"product_id":ID,"product_name":"নাম","price":দাম,"qty":১,"name":"নাম","phone":"${cleanUserPhone}","address":"ঠিকানা"}]]

প্রাসঙ্গিক পণ্য:
${relevantCatalog}
  `;

  // সরাসরি গুগলের দ্রুততম ও স্থিতিশীল মডেল
  const modelName = "gemini-2.0-flash";

  try {
    const model = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: systemInstruction,
      generationConfig: {
        maxOutputTokens: 300,
        temperature: 0.3
      }
    });

    // ২০ সেকেন্ডের নিরাপদ টাইমআউট
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), 20000)
    );

    const generatePromise = model.generateContent(userMessage);
    const result = await Promise.race([generatePromise, timeoutPromise]);
    let replyText = result.response.text();

    // অর্ডার প্লেসমেন্ট
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

    replyText = replyText.replace(/\*\*/g, '*');
    return replyText;

  } catch (err) {
    console.error(`[AI Error - ${modelName}]:`, err.message);
  }

  return "জি ভাইয়া! TechXZone-এ আপনাকে স্বাগতম। আপনি কোন প্রোডাক্টটি দেখতে চাচ্ছেন একটু জানাবেন কি?";
}

// ৭. WhatsApp Baileys ইঞ্জিন
async function initWhatsApp(forceClean = false) {
  try {
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end(undefined); 
      } catch (e) {}
      sock = null;
    }

    if (forceClean) {
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
    } else {
      await restoreFullSession();
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['Mac OS', 'Chrome', '14.4.1'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 0,
      keepAliveIntervalMs: 15000,
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
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`⚠️ কানেকশন বন্ধ হয়েছে (Status Code: ${statusCode})`);

        if (statusCode !== DisconnectReason.loggedOut) {
          setTimeout(() => initWhatsApp(false), 2000);
        } else {
          console.log('🔴 WhatsApp থেকে পার্মানেন্ট লগআউট হয়েছে।');
          try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
        }
      } else if (connection === 'open') {
        isConnected = true;
        pairingCode = null;
        qrCodeData = null;
        pairingErrorMessage = "";
        console.log('🎉 [TechXZone WhatsApp Bot] সফলভাবে কানেক্টেড ও লাইভ আছে!');
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

        const sender = msg.key.remoteJid;
        if (sender.includes('@g.us')) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text) return;

        console.log(`[কাস্টমার]: ${text}`);

        // মেসেজ সাথে সাথে Seen (Blue tick) করা এবং টাইপিং পাঠানো
        sock.readMessages([msg.key]).catch(() => {});
        sock.sendPresenceUpdate('composing', sender).catch(() => {});

        try {
          let aiReply = await generateAiReply(sender, text);
          aiReply = aiReply.replace(/\*\*/g, '*');

          const formRegex = /(📋\s*\*?ক্যাশ অন ডেলিভারি অর্ডার ফর্ম\*?[\s\S]*?━━━━━━━━━━━━━━━━━━━━)/;
          const match = aiReply.match(formRegex);

          if (match) {
            const formText = match[1].trim();
            const otherText = aiReply
              .replace(formRegex, '')
              .replace(/\[\[ORDER:(.*?)\]\]/g, '')
              .trim();

            await sock.sendMessage(sender, { text: formText });

            if (otherText) {
              await delay(300);
              await sock.sendMessage(sender, { text: otherText });
            }
          } else {
            await sock.sendMessage(sender, { text: aiReply });
          }
        } finally {
          // রিপ্লাই পাঠানো শেষ হলে বা ফেইল হলেও টাইপিং অফ হবে
          sock.sendPresenceUpdate('paused', sender).catch(() => {});
        }

      } catch (err) {
        console.error("Message Processing Error:", err.message);
      }
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

// ৯. ড্যাশবোর্ড UI
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
        .btn-danger { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; font-size: 13px; }
        .code-box { background: #ecfdf5; border: 2px dashed #059669; border-radius: 18px; padding: 16px; text-align: center; margin: 12px 0; }
        .code-text { font-size: 34px; font-weight: 900; letter-spacing: 5px; color: #047857; font-family: monospace; }
        .badge { display: inline-block; background: #e0f2fe; color: #0369a1; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; margin-bottom: 12px; }
        .error-box { background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; padding:12px; border-radius:14px; font-size:13px; margin: 12px 0; text-align:center; font-weight:500; }
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

        ${pairingErrorMessage ? `<div class="error-box">${pairingErrorMessage}</div>` : ''}

        ${isConnected 
          ? `<div style="background:#ecfdf5;border:2px solid #a7f3d0;padding:20px;border-radius:18px;text-align:center;">
              <div style="color:#059669;font-weight:900;font-size:18px;">✅ WhatsApp সফলভাবে লাইভ আছে!</div>
              <p style="margin:8px 0 15px;font-size:13px;color:#475569;">বট বিদ্যুৎগতিতে কাস্টমারদের উত্তর দিচ্ছে।</p>
              
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
                    <form action="/hard-reset" method="POST" style="flex:1;">
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

                  <form action="/hard-reset" method="POST" style="margin-top:10px;">
                    <button type="submit" class="btn btn-danger">🗑️ সব সেশন ক্লিয়ার / ফ্রেশ রিসেট</button>
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
    console.log(`🧹 [TechXZone] ${phone} এর জন্য ফ্রেশ সকেট প্রস্তুত করা হচ্ছে...`);
    await initWhatsApp(true);
    await delay(3500);

    if (sock) {
      const code = await sock.requestPairingCode(phone);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log(`🎉 পেয়ারিং কোড: ${pairingCode}`);
    } else {
      pairingErrorMessage = "WhatsApp সার্ভার শুরু হতে পারেনি। আবার চেষ্টা করুন।";
    }
  } catch (err) {
    console.error("Pairing Error:", err.message);
    pairingErrorMessage = `কোড তৈরি হতে সমস্যা হয়েছে: ${err.message}`;
  }
  res.redirect('/');
});

// ১১. কোড রি-সেন্ড
app.post('/resend-code', async (req, res) => {
  if (lastEnteredPhone && sock) {
    try {
      const code = await sock.requestPairingCode(lastEnteredPhone);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    } catch (e) {
      pairingErrorMessage = "কোড পুনরায় পাঠাতে সমস্যা হয়েছে।";
    }
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
  pairingErrorMessage = "";

  await initWhatsApp(true);
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

    let reply = await generateAiReply(phone, message);
    reply = reply.replace(/\*\*/g, '*');
    return res.json({ success: true, reply: reply });
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
  initWhatsApp(false);
});
