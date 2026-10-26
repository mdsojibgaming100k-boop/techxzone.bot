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
const SESSIONS_BASE_DIR = path.join(__dirname, 'txz_multi_sessions');
const CATALOG_CACHE_FILE = path.join(__dirname, 'catalog_cache.json');
const ADMIN_PHONE = process.env.ADMIN_PHONE || "8801404277094"; 

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
let genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

let productCatalog = [];
const conversationHistory = new Map();

// মেমোরি পরিষ্কার
setInterval(() => {
  const now = Date.now();
  for (const [phone, data] of conversationHistory.entries()) {
    if (data.lastUpdated && now - data.lastUpdated > 24 * 60 * 60 * 1000) {
      conversationHistory.delete(phone);
    }
  }
}, 60 * 60 * 1000);

// ৩টি WhatsApp অ্যাকাউন্টের কনফিগারেশন
const accounts = {
  1: { id: 1, name: "WhatsApp লাইন ১", sock: null, isConnected: false, pairingCode: null, lastPhone: "", error: "", backupTimer: null },
  2: { id: 2, name: "WhatsApp লাইন ২", sock: null, isConnected: false, pairingCode: null, lastPhone: "", error: "", backupTimer: null },
  3: { id: 3, name: "WhatsApp লাইন ৩", sock: null, isConnected: false, pairingCode: null, lastPhone: "", error: "", backupTimer: null }
};

function getSessionPath(accId) {
  return path.join(SESSIONS_BASE_DIR, `session_${accId}`);
}

// সেশন ডেটাবেজ থেকে রিস্টোর
async function restoreAccountSession(accId) {
  try {
    const sessionDir = getSessionPath(accId);
    const res = await axios.get(`https://techxzone.shop/api.php?action=get_settings&key=wa_session_acc_${accId}`, { timeout: 10000 });
    const bundle = res.data;
    if (bundle && typeof bundle === 'object' && bundle['creds.json']) {
      await fsPromises.mkdir(sessionDir, { recursive: true });
      for (const [filename, content] of Object.entries(bundle)) {
        await fsPromises.writeFile(
          path.join(sessionDir, filename),
          typeof content === 'string' ? content : JSON.stringify(content)
        );
      }
      console.log(`✅ [TechXZone] লাইন ${accId} ডেটাবেজ থেকে সেশন রিস্টোর হয়েছে!`);
      return true;
    }
  } catch (e) {}
  return false;
}

// সেশন ডেটাবেজে ব্যাকআপ
function scheduleAccountBackup(accId) {
  const acc = accounts[accId];
  clearTimeout(acc.backupTimer);
  acc.backupTimer = setTimeout(async () => {
    try {
      const sessionDir = getSessionPath(accId);
      if (!fs.existsSync(sessionDir)) return;
      const files = await fsPromises.readdir(sessionDir);
      if (files.length === 0 || !files.includes('creds.json')) return;

      const sessionBundle = {};
      for (const file of files) {
        const fullPath = path.join(sessionDir, file);
        const stat = await fsPromises.stat(fullPath);
        if (stat.isFile()) {
          sessionBundle[file] = await fsPromises.readFile(fullPath, 'utf-8');
        }
      }

      await axios.post('https://techxzone.shop/api.php?action=save_settings', {
        key: `wa_session_acc_${accId}`,
        data: sessionBundle
      }, { timeout: 10000 });
      console.log(`💾 [TechXZone] লাইন ${accId} সেশন ডেটাবেজে সেভ হয়েছে!`);
    } catch (e) {}
  }, 4000);
}

// লাইভ ক্যাটালগ
async function updateCatalog() {
  try {
    const res = await axios.get('https://techxzone.shop/api.php?action=bot_catalog', { timeout: 8000 });
    if (res.data && res.data.products) {
      productCatalog = res.data.products;
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

// সরাসরি ওয়েবসাইট অর্ডার
async function createWebsiteOrder(orderInfo, activeSock) {
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
      if (activeSock) {
        const adminJid = `${ADMIN_PHONE.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
        const adminMsg = `🚨 *নতুন অর্ডার বুক হয়েছে!*\n━━━━━━━━━━━━━━━━━━━━\n🆔 অর্ডার আইডি: #${orderId}\n📦 পণ্য: ${orderInfo.product_name}\n👤 কাস্টমার: ${orderInfo.name}\n📞 মোবাইল: ${orderInfo.phone}\n📍 ঠিকানা: ${orderInfo.address}\n💰 মোট বিল: ৳${grandTotal.toLocaleString()}\n━━━━━━━━━━━━━━━━━━━━`;
        activeSock.sendMessage(adminJid, { text: adminMsg }).catch(() => {});
      }
      return { success: true, orderId: orderId, grandTotal: grandTotal };
    }
    return { success: false };
  } catch (err) {
    return { success: false };
  }
}

// AI জেনারেটর
async function generateAiReply(userPhone, userMessage, activeSock) {
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

🎯 নিয়ম:
১. কাস্টমারকে আপন ভাইয়ের মতো "ভাইয়া" সম্বোধন করবে। আন্তরিক ও মিষ্টি গলায় অল্প কথায় স্পষ্ট উত্তর দেবে।
২. কখনো ডাবল স্টার (**) ব্যবহার করবে না! শুধু সিঙ্গেল স্টার (*) ব্যবহার করবে।
৩. ক্যাশ অন ডেলিভারিতে পার্সেল খুলে দেখে টাকা দেওয়ার সুবিধার কথা মনে করিয়ে দেবে।

🧠 অর্ডার ফর্ম দেওয়ার নিয়ম:
- কাস্টমার যদি পণ্য নিয়ে শুধু প্রশ্ন করে, ডেলিভারি চার্জ জানতে চায়, তখন ফর্ম দেবে না।
- ফর্ম শুধুমাত্র তখনই দেবে যখন কাস্টমার একটি নির্দিষ্ট পণ্য ফাইনাল করবে কিন্তু নাম ও ঠিকানা দেয়নি।
- ফর্ম ফরম্যাট:

📋 *ক্যাশ অন ডেলিভারি অর্ডার ফর্ম*
━━━━━━━━━━━━━━━━━━━━

*১. আপনার পুরো নাম :* 

*২. মোবাইল নম্বর :* ${cleanUserPhone}

*৩. সম্পূর্ণ ঠিকানা (বাসা/রোড/এলাকা) :* 

*৪. জেলা ও থানা :* 

*৫. পণ্যের নাম ও সংখ্যা :* [পণ্যের নাম]

━━━━━━━━━━━━━━━━━━━━

🎉 *দারুণ ভাইয়া!* 
💡 উপরের ফর্মটি কপি করে নাম ও ঠিকানা বসিয়ে পাঠিয়ে দিন।
🚚 সারা দেশে ১০০% ক্যাশ অন ডেলিভারি (পার্সেল দেখে টাকা পরিশোধ করবেন)।

অর্ডার সাবমিশন কোড:
[[ORDER:{"product_id":ID,"product_name":"নাম","price":দাম,"qty":১,"name":"নাম","phone":"${cleanUserPhone}","address":"ঠিকানা"}]]

প্রাসঙ্গিক প্রোডাক্ট তালিকা:
${relevantCatalog}
  `;

  const modelsToTry = ["gemini-2.5-flash", "gemini-1.5-flash"];

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
        generationConfig: { maxOutputTokens: 600, temperature: 0.5 }
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

          const orderResult = await createWebsiteOrder(orderData, activeSock);
          if (orderResult.success) {
            const invoiceNote = `\n\n🎉 *আলহামদুলিল্লাহ ভাইয়া! আপনার অর্ডারটি সফলভাবে কনফার্ম করা হয়েছে।* \n🆔 *অর্ডার আইডি:* #${orderResult.orderId}\n📦 *পণ্য:* ${orderData.product_name}\n💰 *সর্বমোট বিল:* ৳${orderResult.grandTotal.toLocaleString()} (ক্যাশ অন ডেলিভারি)\n🚚 পার্সেল পৌঁছে দিলে দেখে মূল্য পরিশোধ করবেন! ❤️`;
            replyText = replyText.replace(/\[\[ORDER:(.*?)\]\]/, '') + invoiceNote;
          }
        } catch (err) {
          replyText = replyText.replace(/\[\[ORDER:(.*?)\]\]/, '');
        }
      }

      replyText = replyText.replace(/\*\*/g, '*');

      cleanHistory.push({ role: "user", parts: [{ text: userMessage }] });
      cleanHistory.push({ role: "model", parts: [{ text: replyText }] });
      conversationHistory.set(userPhone, { history: cleanHistory, lastUpdated: Date.now() });

      return replyText;
    } catch (err) {}
  }

  return "জি ভাইয়া! TechXZone-এ আপনাকে স্বাগতম। আপনি কোন প্রোডাক্টটি দেখতে চাচ্ছেন একটু জানাবেন কি?";
}

// WhatsApp ইনস্ট্যান্স ইনিশিয়ালাইজ করা
async function startWhatsAppInstance(accId) {
  const acc = accounts[accId];
  const sessionDir = getSessionPath(accId);

  try {
    if (acc.sock) {
      try {
        acc.sock.ev.removeAllListeners();
        acc.sock.end(undefined);
      } catch (e) {}
    }

    await restoreAccountSession(accId);

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      auth: state,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', `20.0.${accId}`],
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    acc.sock = sock;

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'close') {
        acc.isConnected = false;
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          setTimeout(() => startWhatsAppInstance(accId), 3000);
        } else {
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
        }
      } else if (connection === 'open') {
        acc.isConnected = true;
        acc.pairingCode = null;
        acc.error = "";
        console.log(`🎉 [TechXZone] ${acc.name} সফলভাবে লাইভ হয়েছে!`);
        scheduleAccountBackup(accId);
      }
    });

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      scheduleAccountBackup(accId);
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

        console.log(`[${acc.name}] কাস্টমার: ${text}`);

        try {
          await sock.readMessages([msg.key]);
          await sock.presenceSubscribe(sender);
          await sock.sendPresenceUpdate('composing', sender);
        } catch (e) {}

        let aiReply = await generateAiReply(sender, text, sock);
        aiReply = aiReply.replace(/\*\*/g, '*');

        const formRegex = /(📋\s*\*?ক্যাশ অন ডেলিভারি অর্ডার ফর্ম\*?[\s\S]*?━━━━━━━━━━━━━━━━━━━━)/;
        const match = aiReply.match(formRegex);

        if (match) {
          const formText = match[1].trim();
          const otherText = aiReply.replace(formRegex, '').replace(/\[\[ORDER:(.*?)\]\]/g, '').trim();

          await sock.sendMessage(sender, { text: formText });
          if (otherText) {
            await delay(1000);
            await sock.sendMessage(sender, { text: otherText });
          }
        } else {
          await sock.sendMessage(sender, { text: aiReply });
        }

        try {
          await sock.sendPresenceUpdate('paused', sender);
        } catch (e) {}

      } catch (err) {}
    });

  } catch (err) {
    console.error(`লাইন ${accId} শুরু করতে সমস্যা:`, err.message);
  }
}

// সার্ভার চালু হলে সবগুলো লাইন শুরু করা
async function initAllAccounts() {
  await fsPromises.mkdir(SESSIONS_BASE_DIR, { recursive: true });
  for (const id of [1, 2, 3]) {
    await startWhatsAppInstance(id);
    await delay(1500);
  }
}

// অটো পিংগার
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    axios.get(process.env.RENDER_EXTERNAL_URL).catch(() => {});
  }, 4 * 60 * 1000);
}

// ড্যাশবোর্ড UI (একসাথে ৩টি লাইন সাপোর্ট ও পৃথক রিসেট বাটন)
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>TechXZone Multi-WhatsApp Bot</title>
      <style>
        body { font-family: sans-serif; background: #f8fafc; color: #0f172a; padding: 15px; margin: 0; }
        .container { max-width: 480px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 16px; }
        .card { background: #fff; border-radius: 20px; padding: 18px; margin-bottom: 16px; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1.5px solid #e2e8f0; }
        .badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; }
        .badge-green { background: #dcfce7; color: #15803d; }
        .badge-red { background: #fee2e2; color: #b91c1c; }
        input[type="text"] { width: 100%; box-sizing: border-box; padding: 11px 13px; border-radius: 12px; border: 1.5px solid #cbd5e1; font-size: 14px; margin-top: 8px; outline: none; }
        .btn { width: 100%; border: none; padding: 12px; border-radius: 12px; font-weight: bold; font-size: 13px; cursor: pointer; margin-top: 8px; display: flex; align-items: center; justify-content: center; gap: 6px; }
        .btn-green { background: #059669; color: #fff; }
        .btn-copy { background: #0284c7; color: #fff; }
        .btn-gray { background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; }
        .btn-danger { background: #fff1f2; color: #e11d48; border: 1.5px solid #fecdd3; }
        .code-box { background: #ecfdf5; border: 2px dashed #059669; border-radius: 14px; padding: 12px; text-align: center; margin: 10px 0; }
        .code-text { font-size: 28px; font-weight: 900; letter-spacing: 4px; color: #047857; font-family: monospace; }
        .error-box { background:#fef2f2; border:1px solid #fca5a5; color:#991b1b; padding:10px; border-radius:12px; font-size:12px; margin-top:8px; }
      </style>
      <script>
        function copyCode(code, btnId) {
          navigator.clipboard.writeText(code).then(() => {
            const btn = document.getElementById(btnId);
            btn.innerHTML = "✅ কপি হয়েছে!";
            btn.style.background = "#10b981";
            setTimeout(() => {
              btn.innerHTML = "📋 কোডটি কপি করুন";
              btn.style.background = "#0284c7";
            }, 2500);
          });
        }
      </script>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2 style="margin:0 0 4px;font-size:20px;">TechXZone WhatsApp Manager</h2>
          <span style="font-size:12px;color:#64748b;">এক সাথে ৩টি WhatsApp লাইন সিস্টেম</span>
          <div style="margin-top:6px;">
            <span class="badge" style="background:#e0f2fe;color:#0369a1;">📦 ক্যাটালগ সিঙ্ক: ${productCatalog.length} টি</span>
          </div>
        </div>

        ${[1, 2, 3].map(id => {
          const acc = accounts[id];
          const cleanCode = acc.pairingCode ? acc.pairingCode.replace(/[^A-Za-z0-9]/g, '') : '';
          
          return `
            <div class="card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
                <span style="font-weight:bold;font-size:15px;">${acc.name}</span>
                <span class="badge ${acc.isConnected ? 'badge-green' : 'badge-red'}">
                  ${acc.isConnected ? '🟢 লাইভ কানেক্টেড' : '🔴 অফলাইন / ডিসকানেক্ট'}
                </span>
              </div>

              ${acc.error ? `<div class="error-box">${acc.error}</div>` : ''}

              ${acc.isConnected 
                ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;padding:12px;border-radius:12px;text-align:center;font-size:13px;color:#166534;margin-bottom:8px;">
                     বট সফলভাবে চালু আছে এবং লাইভ উত্তর দিচ্ছে।
                   </div>`
                : (acc.pairingCode 
                    ? `<div>
                        <div class="code-box">
                          <span style="font-size:11px;color:#065f46;font-weight:bold;">Pairing Code:</span>
                          <div class="code-text">${acc.pairingCode}</div>
                          <span style="font-size:11px;color:#64748b;">নম্বর: <b>${acc.lastPhone}</b></span>
                        </div>
                        <button type="button" id="copyBtn_${id}" onclick="copyCode('${cleanCode}', 'copyBtn_${id}')" class="btn btn-copy">📋 কোডটি কপি করুন</button>
                       </div>`
                    : `<form action="/get-code/${id}" method="POST">
                        <input type="text" name="phone" placeholder="WhatsApp নম্বর দিন (যেমন: 01404277094)" required />
                        <button type="submit" class="btn btn-green">📲 কোড নিন (Pairing Code)</button>
                       </form>`
                  )
              }

              <!-- 🔴 সবসময় দৃশ্যমান লগআউট / রিসেট বাটন -->
              <form action="/reset/${id}" method="POST" style="margin-top:6px;">
                <button type="submit" class="btn btn-danger">🗑️ সেশন ক্লিয়ার / লগআউট করুন</button>
              </form>
            </div>
          `;
        }).join('')}

      </div>
    </body>
    </html>
  `);
});

// পেয়ারিং কোড রিকোয়েস্ট (স্বয়ংক্রিয় সেশন ক্লিনিং সহ)
app.post('/get-code/:id', async (req, res) => {
  const accId = req.params.id;
  const acc = accounts[accId];
  if (!acc) return res.redirect('/');

  let phone = (req.body.phone || '').replace(/[^0-9]/g, '');
  if (!phone) return res.redirect('/');
  if (phone.length === 11 && phone.startsWith('01')) phone = '88' + phone;

  acc.lastPhone = phone;
  acc.error = "";
  acc.pairingCode = null;

  try {
    const sessionDir = getSessionPath(accId);

    // অফলাইন অবস্থায় নতুন পেয়ারিং চাইলে আগের নষ্ট সেশন নিজে থেকেই মুছে ফ্রেশ শুরু করবে
    if (!acc.isConnected) {
      try {
        if (fs.existsSync(sessionDir)) {
          await fsPromises.rm(sessionDir, { recursive: true, force: true });
        }
      } catch (e) {}
      await startWhatsAppInstance(accId);
      await delay(3500);
    }

    if (acc.sock) {
      console.log(`[লাইন ${accId}] ${phone} নম্বরের জন্য কোড চাওয়া হচ্ছে...`);
      const code = await acc.sock.requestPairingCode(phone);
      acc.pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
    } else {
      acc.error = "সকেট প্রস্তুত হয়নি। আবার চেষ্টা করুন।";
    }
  } catch (err) {
    console.error(`লাইন ${accId} Pairing Error:`, err.message);
    acc.error = `কোড পাওয়া যায়নি: ${err.message}। সেশন ক্লিয়ার বাটনে চাপ দিয়ে আবার ট্রাই করুন।`;
  }

  res.redirect('/');
});

// নির্দিষ্ট লাইনের সেশন হার্ড রিসেট
app.post('/reset/:id', async (req, res) => {
  const accId = req.params.id;
  const acc = accounts[accId];
  if (!acc) return res.redirect('/');

  acc.pairingCode = null;
  acc.lastPhone = "";
  acc.isConnected = false;
  acc.error = "";

  const sessionDir = getSessionPath(accId);

  try {
    if (fs.existsSync(sessionDir)) {
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    }
  } catch (e) {}

  try {
    await axios.post('https://techxzone.shop/api.php?action=save_settings', {
      key: `wa_session_acc_${accId}`,
      data: {}
    }, { timeout: 5000 });
  } catch (e) {}

  if (acc.sock) {
    try {
      acc.sock.ev.removeAllListeners();
      acc.sock.end(undefined);
    } catch (e) {}
  }

  setTimeout(() => startWhatsAppInstance(accId), 1500);
  res.redirect('/');
});

// ওয়েবসাইটের জন্য AI চ্যাট
app.post('/api/ai-chat', async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const message = req.body.message || req.body.prompt || "";
    const phone = req.body.phone || "01404277094";

    if (!message) return res.json({ success: false, reply: "মেসেজ লিখুন..." });

    // যেকোনো একটি একটিভ সকেট নেওয়া
    const activeSock = accounts[1].sock || accounts[2].sock || accounts[3].sock;
    let reply = await generateAiReply(phone, message, activeSock);
    reply = reply.replace(/\*\*/g, '*');
    return res.json({ success: true, reply: reply });
  } catch (err) {
    return res.json({ success: false, reply: "জি ভাইয়া! একটু কারিগরি সমস্যা হচ্ছে।" });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Multi-Bot server running on port ${PORT}`);
  initAllAccounts();
});
