const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
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
let compactCatalogText = "";
const conversationHistory = new Map();
const userMessageBuffers = new Map();
let backupTimer = null;

// ২. সম্পূর্ণ WhatsApp সেশন ডেটাবেজে ব্যাকআপ ও রিস্টোর
async function restoreFullSession() {
  try {
    const res = await axios.get('https://techxzone.shop/api.php?action=get_settings&key=wa_full_session_bundle', { timeout: 10000 });
    const bundle = res.data;
    if (bundle && typeof bundle === 'object' && bundle['creds.json']) {
      if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });
      for (const [filename, content] of Object.entries(bundle)) {
        fs.writeFileSync(path.join(SESSION_DIR, filename), typeof content === 'string' ? content : JSON.stringify(content));
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
      const files = fs.readdirSync(SESSION_DIR);
      if (files.length === 0 || !files.includes('creds.json')) return;

      const sessionBundle = {};
      for (const file of files) {
        const fullPath = path.join(SESSION_DIR, file);
        if (fs.statSync(fullPath).isFile()) {
          sessionBundle[file] = fs.readFileSync(fullPath, 'utf-8');
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
      compactCatalogText = productCatalog.map(p => 
        `• [ID:${p.id}] ${p.name} | মূল্য: ৳${p.price} | স্টক: ${p.in_stock} | লিংক: ${p.buy_link}`
      ).join('\n');
      console.log(`[TechXZone] মোট ${productCatalog.length} টি প্রোডাক্ট সিঙ্ক হয়েছে।`);
    }
  } catch (err) {}
}
updateCatalog();
setInterval(updateCatalog, 15 * 60 * 1000);

// ৪. সাইটে সরাসরি অর্ডার তৈরি
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
    return { success: false };
  }
}

// ৫. আল্ট্রা-ফাস্ট মানবিক AI ইঞ্জিন
async function generateAiReply(userPhone, userMessage) {
  if (!genAI || !GEMINI_API_KEY) {
    return "আসসালামু আলাইকুম ভাইয়া! Render ড্যাশবোর্ডে GEMINI_API_KEY সেট করুন।";
  }

  const cleanUserPhone = userPhone.replace(/[^0-9]/g, '').slice(-11);

  const systemInstruction = `
তুমি TechXZone (techxzone.shop) এর অত্যন্ত আন্তরিক, বিনয়ী ও বাস্তব সেলস এক্সিকিউটিভ (মানুষ)। তোমার নাম TechXZone টিম।

নিয়মাবলী:
১. মানুষের মতো অনুভূতি: রক্ত-মাংসের মানুষের মতো মিষ্টি ও ভদ্র ভাষায় কথা বলবে। কাস্টমারকে "ভাইয়া" সম্বোধন করবে। কখনো বলবে না তুমি বট।
২. প্রোডাক্ট ও দাম: কাস্টমার যা খুঁজবে (যেমন: ফ্যান, ব্যাটারি, ইউপিএস), তালিকা দেখে সঠিক নাম, দাম ও কেনার লিংক দেবে।
৩. ক্যাশ অন ডেলিভারি: মনে করিয়ে দেবে সারা দেশে ১০০% ক্যাশ অন ডেলিভারি (পণ্য হাতে পেয়ে চেক করে টাকা দেওয়া)।
৪. সুন্দর অর্ডার ফর্ম পাঠানোর নিয়ম (খুব গুরুত্বপূর্ণ):
   - কাস্টমার যদি পণ্য নিতে চায়, বা বলে "অর্ডার কনফার্ম করেন", "১ নম্বরটা নিব", কিন্তু নাম ও সম্পূর্ণ ঠিকানা দেয়নি—তখন তাকে মিষ্টি করে হুবহু নিচের সুন্দর ফর্মটি পাঠিয়ে দেবে:

🎉 *দারুণ ভাইয়া! অর্ডারটি কনফার্ম করতে অনুগ্রহ করে নিচের ফর্মটি পূরণ করে পাঠিয়ে দিন:*

📝 *অর্ডার ফর্ম:*
• আপনার নাম: 
• মোবাইল নম্বর: ${cleanUserPhone}
• সম্পূর্ণ ঠিকানা (বাসা/রোড/এলাকা): 
• জেলা ও থানা: 
• পণ্যের নাম ও পরিমাণ: 

*(আপনি চাইলে উপরের লেখাটি কপি করে শুধু আপনার তথ্য বসিয়ে পাঠিয়ে দিতে পারেন)*
🚚 সারা দেশে ১০০% ক্যাশ অন ডেলিভারি (পার্সেল হাতে পেয়ে টাকা দিবেন)।

৫. সরাসরি অর্ডার বুকিং:
   - কাস্টমার যখন তার নাম ও সম্পূর্ণ ঠিকানা পাঠিয়ে দেবে, তখন তার অর্ডারটি নিশ্চিত করার জন্য উত্তরের একদম শেষে এই গোপন কোডটি বসিয়ে দেবে:
   [[ORDER:{"product_id":ID,"product_name":"পণ্যের নাম","price":দাম,"qty":১,"name":"গ্রাহকের নাম","phone":"${cleanUserPhone}","address":"গ্রাহকের ঠিকানা"}]]

প্রোডাক্ট তালিকা:
${compactCatalogText || 'পণ্য লোড হচ্ছে...'}
  `;

  const modelsToTry = ["gemini-2.5-flash", "gemini-1.5-flash", "gemini-2.0-flash"];

  let rawHistory = conversationHistory.get(userPhone) || [];
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
        generationConfig: { maxOutputTokens: 650, temperature: 0.6 }
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

      // অর্ডার বুকিং সনাক্তকরণ
      const orderMatch = replyText.match(/\[\[ORDER:(.*?)\]\]/);
      if (orderMatch && orderMatch[1]) {
        try {
          const orderData = JSON.parse(orderMatch[1]);
          if (!orderData.phone) orderData.phone = cleanUserPhone;

          const orderResult = await createWebsiteOrder(orderData);
          if (orderResult.success) {
            const invoiceNote = `\n\n🎉 *আলহামদুলিল্লাহ ভাইয়া! আপনার অর্ডারটি নিশ্চিত করা হয়েছে।* \n🆔 *অর্ডার আইডি:* #${orderResult.orderId}\n📦 *পণ্য:* ${orderData.product_name}\n💰 *সর্বমোট বিল:* ৳${orderResult.grandTotal.toLocaleString()} (ক্যাশ অন ডেলিভারি)\n🚚 পার্সেল পৌঁছে দিলে দেখে মূল্য পরিশোধ করবেন। ধন্যবাদ TechXZone এর সাথে থাকার জন্য! ❤️`;
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
    } catch (err) {}
  }

  return "জি ভাইয়া! TechXZone-এ আপনাকে স্বাগতম। আপনি কোন প্রোডাক্টটি নিতে চাচ্ছেন একটু জানাবেন কি?";
}

// ৬. WhatsApp Baileys ইঞ্জিন (টাইপিং ইন্ডিকেটর ও ফাস্ট রেসপন্স)
async function initWhatsApp() {
  try {
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

        const sender = msg.key.remoteJid;
        if (sender.includes('@g.us')) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text) return;

        console.log(`[কাস্টমার]: ${text}`);

        // 🚀 কাস্টমার মেসেজ দিলেই সাথে সাথে "typing..." দেখানো
        await sock.sendPresenceUpdate('composing', sender);

        let currentBuffer = userMessageBuffers.get(sender) || [];
        currentBuffer.push(text);
        userMessageBuffers.set(sender, currentBuffer);

        // মাত্র ০.৫ সেকেন্ড বাফার (আগের ২ সেকেন্ডের চেয়ে ৪ গুণ ফাস্ট!)
        setTimeout(async () => {
          const bufferedMsgs = userMessageBuffers.get(sender);
          if (!bufferedMsgs || bufferedMsgs.length === 0) return;

          userMessageBuffers.delete(sender);
          const combinedMessage = bufferedMsgs.join(' ');

          const aiReply = await generateAiReply(sender, combinedMessage);
          await sock.sendMessage(sender, { text: aiReply });
          await sock.sendPresenceUpdate('paused', sender);
        }, 500);

      } catch (err) {}
    });

  } catch (err) {
    console.error("WhatsApp Init Error:", err.message);
  }
}

// ৭. অটো পিংগার (Keep Alive)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }, 4 * 60 * 1000);
}

// ৮. ড্যাশবোর্ড
app.get('/', (req, res) => {
  const cleanCodeNoDash = pairingCode ? pairingCode.replace(/[^A-Za-z0-9]/g, '') : '';

  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TechXZone Ultra-Fast AI & Order Bot</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; color: #0f172a; padding: 15px; margin: 0; }
        .card { max-width: 440px; margin: 20px auto; background: #fff; border-radius: 24px; padding: 22px; box-shadow: 0 10px 25px rgba(0,0,0,0.07); border: 1px solid #e2e8f0; }
        input[type="text"] { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 14px; border: 1.5px solid #cbd5e1; font-size: 15px; margin-top: 8px; outline: none; }
        .btn { width: 100%; border: none; padding: 13px; border-radius: 14px; font-weight: bold; font-size: 14px; cursor: pointer; margin-top: 10px; display: flex; align-items: center; justify-content: center; gap: 8px; }
        .btn-green { background: #059669; color: #fff; }
        .btn-copy { background: #0284c7; color: #fff; }
        .btn-gray { background: #e2e8f0; color: #334155; }
        .btn-danger { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; font-size: 12px; }
        .code-box { background: #ecfdf5; border: 2px dashed #059669; border-radius: 18px; padding: 16px; text-align: center; margin: 12px 0; }
        .code-text { font-size: 34px; font-weight: 900; letter-spacing: 5px; color: #047857; font-family: monospace; }
        .alert-error { background: #fef2f2; border: 1.5px solid #f87171; color: #991b1b; padding: 12px; border-radius: 14px; font-size: 12px; margin-bottom: 12px; }
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
        <h2 style="margin:0 0 4px;text-align:center;font-size:20px;">TechXZone WhatsApp AI</h2>
        <p style="text-align:center;color:#64748b;font-size:12px;margin:0 0 16px;">Ultra-Fast Response + Direct Order System</p>

        ${pairingErrorMessage ? `<div class="alert-error">⚠️ ${pairingErrorMessage}</div>` : ''}

        ${isConnected 
          ? `<div style="background:#ecfdf5;border:2px solid #a7f3d0;padding:20px;border-radius:18px;text-align:center;">
              <div style="color:#059669;font-weight:900;font-size:18px;">✅ WhatsApp সফলভাবে লাইভ আছে!</div>
              <p style="margin:8px 0 15px;font-size:13px;color:#475569;">বট বিদ্যুৎগতিতে উত্তর দিচ্ছে ও অর্ডার নিচ্ছে।</p>
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

// ৯. পেয়ারিং কোড রিকোয়েস্ট
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

// ১০. কোড রি-সেন্ড
app.post('/resend-code', async (req, res) => {
  if (lastEnteredPhone && sock && !sock.authState.creds.registered) {
    try {
      const code = await sock.requestPairingCode(lastEnteredPhone);
      pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    } catch (e) {}
  }
  res.redirect('/');
});

// ১১. নম্বর পরিবর্তন
app.post('/change-number', (req, res) => {
  pairingCode = null;
  res.redirect('/');
});

// ১২. হার্ড রিসেট
app.post('/hard-reset', async (req, res) => {
  pairingCode = null;
  lastEnteredPhone = "";
  isConnected = false;

  try {
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
  } catch (e) {}

  try {
    await axios.post('https://techxzone.shop/api.php?action=save_settings', {
      key: 'wa_full_session_bundle',
      data: {}
    }, { timeout: 5000 });
  } catch (e) {}

  if (sock) {
    try { sock.end(undefined); } catch (e) {}
  }

  setTimeout(initWhatsApp, 2000);
  res.redirect('/');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  initWhatsApp();
});
