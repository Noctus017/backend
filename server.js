// server.js — Front estático + Stripe (cartão) + PIX offline (QR local)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Stripe = require('stripe');
const QRCode = require('qrcode');

const app = express();

const {
  STRIPE_SECRET_KEY,
  PORT = 4242,
  FRONTEND_URL = 'http://localhost:4242', // fallback
} = process.env;

// Stripe opcional (apenas cartão); sem chave => PIX offline funciona normal
let stripe = null;
if (!STRIPE_SECRET_KEY) {
  console.warn('⚠️ STRIPE_SECRET_KEY não definida — Cartão via Stripe desabilitado. PIX offline continua funcionando.');
} else {
  stripe = Stripe(STRIPE_SECRET_KEY);
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// === Servir FRONT estático (index.html, sucesso.html, cancelado.html, css/js) ===
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR)); // agora abra http://localhost:4242/

// Health
app.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Util para base de retorno (success/cancel) — usa Origin do navegador ou fallback
function getReturnBase(req, explicitBase) {
  const raw =
    explicitBase ||
    req.get('origin') || // ex.: http://localhost:4242
    FRONTEND_URL;
  const trimmed = String(raw).replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return FRONTEND_URL.replace(/\/+$/, '');
  return trimmed;
}

// ========== Cartão (Stripe Checkout) ==========
app.post('/create-checkout-session', async (req, res) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Stripe não configurado' });

    let { amount, method = 'card', returnBase } = req.body || {};
    if (amount == null) return res.status(400).json({ error: 'amount é obrigatório' });

    amount = Number(amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'amount inválido' });
    }

    const unitAmount = Math.round(amount * 100);
    const types =
      method === 'card' ? ['card'] :
      method === 'pix'  ? ['pix']  :
      ['card', 'pix'];

    const payment_method_options = {};
    if (types.includes('pix')) {
      payment_method_options.pix = { expires_after_seconds: 1800 };
    }

 // onde cria a session do Stripe:
      
    const base = getReturnBase(req, returnBase);
    const successUrl = `${base}/sucesso.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = `${base}/cancelado.html`;

// ... checkout.sessions.create({ ..., success_url: successUrl, cancel_url: cancelUrl })

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: types,
      line_items: [
        {
          price_data: {
            currency: 'brl',
            product_data: { name: 'Doação • Projeto Lar Carioca' },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      payment_method_options,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { origem: 'site', projeto: 'LarCarioca' },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Erro ao criar sessão:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao criar sessão de pagamento' });
  }
});

// ========== PIX Offline (QR gerado localmente) ==========
app.post('/pix/qrcode', async (req, res) => {
  try {
    const { brcode, size = 220 } = req.body || {};
    if (!brcode || typeof brcode !== 'string' || brcode.length < 20) {
      return res.status(400).json({ error: 'brcode inválido' });
    }

    const dataUrl = await QRCode.toDataURL(brcode, {
      width: Number(size) || 220,
      margin: 1,
      errorCorrectionLevel: 'M'
    });

    return res.json({ dataUrl });
  } catch (err) {
    console.error('Erro ao gerar QR:', err?.message || err);
    return res.status(500).json({ error: 'Falha ao gerar QR Code' });
  }
});

// ========== Confirmação de sessão (Stripe) ==========
// GET /checkout-session/:id -> retorna o status real da sessão do Checkout
app.get('/checkout-session/:id', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Stripe não configurado' });
    }

    const { id } = req.params;
    // valida um id do tipo cs_*******
    if (!/^cs_[A-Za-z0-9]+$/.test(id)) {
      return res.status(400).json({ error: 'id inválido' });
    }

    const session = await stripe.checkout.sessions.retrieve(id, {
      expand: ['payment_intent']
    });

    return res.json({
      payment_status: session.payment_status,        // 'paid' quando OK
      amount_total: session.amount_total,           // em centavos
      currency: session.currency,                   // 'brl'
      payment_intent_status: session.payment_intent?.status // e.g. 'succeeded'/'processing'
    });
  } catch (e) {
    console.error('Falha ao consultar sessão:', e?.message || e);
    return res.status(500).json({ error: 'Falha ao consultar sessão' });
  }
});


app.listen(PORT, () => {
  console.log(`✅ API + Front em http://localhost:${PORT}`);
});
