const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason, 
  delay, 
  Browsers, 
  fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const pino = require('pino');

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
      console.log(`✅ [TechXZone] ডেটাবেজ থেকে মোট ${Object.keys(bundle).length}টি ফাইল রিস্টোর হয়েছে!`);
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
      console.log(`💾 [TechXZone] সেশন ফাইল ডেটাবেজে পার্মানেন্ট সেভ হয়েছে!`);
    } catch (e) {}
  }, 3000);
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
      customerNote: `WhatsApp Bot Order (${orderInfo.product_name})`,
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

// ৫. এআই রিপ্লাই ইঞ্জিন
async function generateAiReply(userPhone, userMessage) {
  if (!genAI || !GEMINI_API_KEY) {
    return "আসসালামু আলাইকুম ভাইয়া! Render ড্যাশবোর্ডে GEMINI_API_KEY সেট করুন।";
  }

  try {
    const cleanUserPhone = userPhone.replace(/[^0-9]/g, '').slice(-11);

    const systemInstruction = `
তুমি TechXZone (techxzone.shop) এর অত্যন্ত আন্তরিক, বিনয়ী ও বাস্তব সেলস এক্সিকিউটিভ (মানুষ)। তোমার নাম TechXZone সাপোর্ট টিম।

নিয়মাবলী:
১. মানুষের মতো অনুভূতি: মিষ্টি ও ভদ্র ভাষায় কথা বলবে। কাস্টমারকে "ভাইয়া" সম্বোধন করবে। কখনো বলবে না তুমি এআই বা বট। ভুল হলে সুন্দর করে ক্ষমা চাইবে ("দুঃখিত ভাইয়া, বুঝতে ভুল হয়েছিল...")।
২. প্রোডাক্ট ও দাম: কাস্টমার যা খুঁজবে, নিচের তালিকা দেখে নাম, সঠিক দাম ও লিংক দেবে।
৩. সরাসরি WhatsApp অর্ডার নেওয়া:
   - কাস্টমার যদি পণ্য অর্ডার করতে চায় কিন্তু নাম-ঠিকানা দেয়নি, বলবে: "জি ভাইয়া! আপনার পছন্দের পণ্যটি কনফার্ম করতে আপনার ১) নাম ও ২) সম্পূর্ণ ডেলিভারি ঠিকানা (জেলা সহ) লিখে পাঠিয়ে দিন।"
   - নাম-ঠিকানা দিলে উত্তরের শেষে এই কোডটি দেবে:
   [[ORDER:{"product_id":ID,"product_name":"নাম","price":দাম,"qty":১,"name":"গ্রাহকের নাম","phone":"${cleanUserPhone}","address":"গ্রাহকের ঠিকানা"}]]

ক্যাটালগ:
${compactCatalogText || 'পণ্য লোড হচ্ছে...'}
    `;

    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      systemInstruction: systemInstruction,
      generationConfig: { maxOutputTokens: 600, temperature: 0.7 }
    });

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
    return "জি ভাইয়া, আমি বুঝতে পেরেছি! আপনার পছন্দের প্রোডাক্টটি কনফার্ম করতে অনুগ্রহ করে আপনার নাম ও সম্পূর্ণ ঠিকানা (জেলা সহ) লিখে পাঠিয়ে দিন।";
  }
}

// ৬. WhatsApp Baileys ইঞ্জিন (অফিসিয়াল লেটেস্ট ভার্সন ও ডেক্সটপ সিগনেচার ফিক্স)
async function initWhatsApp() {
  await restoreFullSession();

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  // 🚀 লেটেস্ট প্রোটোকল ভার্সন লোড করা
  let waVersion = [2, 3000, 1015901307];
  try {
    const v = await fetchLatestBaileysVersion();
    if (v && v.version) waVersion = v.version;
  } catch (e) {}

  sock = makeWASocket({
    version: waVersion,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.windows('Desktop'), // 💻 ডিভাইস নেম: Windows Desktop Chrome
    syncFullHistory: false,               // ⚡ নো-হ্যাং ফিক্স
    markOnlineOnConnect: false,
    defaultQueryTimeoutMs: undefined,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // কিউআর কোড আসলে ওয়েব পেজে ছবি বানানো
    if (qr) {
      QRCode.toDataURL(qr, (err, url) => {
        if (!err) qrCodeData = url;
      });
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        initWhatsApp();
      } else {
        console.log("ফোন থেকে লগআউট হয়েছে।");
        try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch (e) {}
      }
    } else if (connection === 'open') {
      isConnected = true;
      pairingCode = null;
      qrCodeData = null;
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

      let currentBuffer = userMessageBuffers.get(sender) || [];
      currentBuffer.push(text);
      userMessageBuffers.set(sender, currentBuffer);

      setTimeout(async () => {
        const bufferedMsgs = userMessageBuffers.get(sender);
        if (!bufferedMsgs || bufferedMsgs.length === 0) return;

        userMessageBuffers.delete(sender);
        const combinedMessage = bufferedMsgs.join(' ');

        const aiReply = await generateAiReply(sender, combinedMessage);
        await sock.sendMessage(sender, { text: aiReply });
      }, 2000);

    } catch (err) {}
  });
}

// ৭. অটো পিংগার
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }, 4 * 60 * 1000);
}

// ৮. উন্নত ড্যাশবোর্ড (Pairing Code + Live QR Code)
app.get('/', (req, res) => {
  const cleanCodeNoDash = pairingCode ? pairingCode.replace(/[^A-Za-z0-9]/g, '') : '';

  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TechXZone WhatsApp Link Manager</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; color: #0f172a; padding: 15px; margin: 0; }
        .card { max-width: 440px; margin: 20px auto; background: #fff; border-radius: 24px; padding: 22px; box-shadow: 0 10px 25px rgba(0,0,0,0.07); border: 1px solid #e2e8f0; }
        input[type="text"] { width: 100%; box-sizing: border-box; padding: 12px 14px; border-radius: 14px; border: 1.5px solid #cbd5e1; font-size: 15px; margin-top: 8px; outline: none; }
        input[type="text"]:focus { border-color: #059669; }
        .btn { width: 100%; border: none; padding: 13px; border-radius: 14px; font-weight: bold; font-size: 14px; cursor: pointer; margin-top: 10px; display: flex; align-items: center; justify-content: center; gap: 8px; transition: 0.2s; }
        .btn-green { background: #059669; color: #fff; }
        .btn-green:hover { background: #047857; }
        .btn-copy { background: #0284c7; color: #fff; font-size: 15px; }
        .btn-gray { background: #e2e8f0; color: #334155; }
        .btn-danger { background: #fee2e2; color: #b91c1c; border: 1px solid #fca5a5; font-size: 12px; padding: 9px; }
        .code-box { background: #ecfdf5; border: 2px dashed #059669; border-radius: 18px; padding: 16px; text-align: center; margin: 12px 0; }
        .code-text { font-size: 34px; font-weight: 900; letter-spacing: 5px; color: #047857; font-family: monospace; }
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
          }).catch(() => {
            prompt("কোডটি কপি করে নিন:", code);
          });
        }
      </script>
    </head>
    <body>
      <div class="card">
        <h2 style="margin:0 0 4px;text-align:center;font-size:20px;">TechXZone WhatsApp Bot</h2>
        <p style="text-align:center;color:#64748b;font-size:12px;margin:0 0 16px;">Windows Desktop Signature Linked</p>

        ${isConnected 
          ? `<div style="background:#ecfdf5;border:2px solid #a7f3d0;padding:20px;border-radius:18px;text-align:center;">
              <div style="color:#059669;font-weight:900;font-size:18px;">✅ WhatsApp সফলভাবে লাইভ আছে!</div>
              <p style="margin:8px 0 15px;font-size:13px;color:#475569;">বট সক্রিয়ভাবে চ্যাট করছে ও স্বয়ংক্রিয় অর্ডার নিচ্ছে।</p>
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

                  <div style="background:#f8fafc;border:1px solid #e2e8f0;padding:12px;border-radius:14px;font-size:11px;color:#475569;margin-top:10px;line-height:1.5;">
                    👉 <b>WhatsApp</b> ➡️ <b>Linked Devices</b> ➡️ <b>Link a Device</b> ➡️ <b>"Link with phone number instead"</b> এ গিয়ে পেস্ট করুন।
                  </div>

                  <div style="display:flex;gap:8px;margin-top:10px;">
                    <form action="/resend-code" method="POST" style="flex:1;">
                      <button type="submit" class="btn btn-gray" style="margin-top:0;">🔄 আবার পাঠান</button>
                    </form>
                    <form action="/change-number" method="POST" style="flex:1;">
                      <button type="submit" class="btn btn-gray" style="margin-top:0;">✏️ নম্বর পরিবর্তন</button>
                    </form>
                  </div>

                  <div style="margin-top:14px;border-top:1px solid #e2e8f0;padding-top:10px;">
                    <form action="/hard-reset" method="POST">
                      <button type="submit" class="btn btn-danger" style="margin-top:0;">🧹 পুরাতন আটকে থাকা সেশন ক্লিয়ার করুন</button>
                    </form>
                  </div>
                 </div>`
              : `<div>
                  <form action="/get-code" method="POST">
                    <label style="font-size:13px;font-weight:bold;color:#334155;">WhatsApp নম্বর দিয়ে কোড নিন:</label>
                    <input type="text" name="phone" placeholder="যেমন: 01771049068" required autofocus />
                    <button type="submit" class="btn btn-green">📲 কোড নিন (Pairing Code)</button>
                  </form>

                  ${qrCodeData ? `
                    <div style="text-align:center;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:15px;">
                      <span style="font-size:12px;font-weight:bold;color:#64748b;">অথবা সরাসরি QR কোড স্ক্যান করুন:</span>
                      <div style="margin-top:10px;">
                        <img src="${qrCodeData}" style="width:190px;height:190px;border:3px solid #059669;border-radius:14px;" />
                      </div>
                    </div>
                  ` : ''}

                  <div style="margin-top:18px;border-top:1px solid #e2e8f0;padding-top:12px;">
                    <form action="/hard-reset" method="POST">
                      <button type="submit" class="btn btn-danger" style="margin-top:0;">🧹 পুরাতন আটকে থাকা সেশন ক্লিয়ার করুন</button>
                    </form>
                  </div>
                 </div>`
            )
        }
      </div>
    </body>
    </html>
  `);
});

// ৯. পেয়ারিং কোড জেনারেট
app.post('/get-code', async (req, res) => {
  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.redirect('/');
  if (phone.length === 11 && phone.startsWith('01')) phone = '88' + phone;

  lastEnteredPhone = phone;

  try {
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

  await initWhatsApp();
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initWhatsApp();
});
