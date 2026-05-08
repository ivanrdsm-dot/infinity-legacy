/*
 * Infinity Legacy — Conversions API server-side endpoint
 *
 * Recibe eventos del navegador (vía POST desde tracking.js) y los reenvía
 * a Meta Conversions API server-to-server. Esto permite que los eventos
 * lleguen a Meta INCLUSO si el Pixel del navegador es bloqueado por iOS,
 * adblockers o navegadores con privacidad agresiva.
 *
 * Meta deduplica automáticamente los eventos del Pixel y CAPI usando el
 * `event_id` compartido entre ambos.
 *
 * Variables de entorno requeridas (configuradas en Vercel):
 *   - PIXEL_ID           (plain text)
 *   - CAPI_ACCESS_TOKEN  (encrypted)
 */

const crypto = require('crypto');

// Hash con SHA-256 (Meta requiere PII hasheada para privacy)
function sha256(value) {
  if (!value) return null;
  return crypto
    .createHash('sha256')
    .update(String(value).toLowerCase().trim())
    .digest('hex');
}

module.exports = async function handler(req, res) {
  // CORS — permite que el navegador del visitante llame este endpoint
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PIXEL_ID = process.env.PIXEL_ID;
  const TOKEN = process.env.CAPI_ACCESS_TOKEN;

  if (!PIXEL_ID || !TOKEN) {
    return res.status(500).json({ error: 'Server env not configured' });
  }

  try {
    // Vercel parsea automáticamente JSON body cuando Content-Type es application/json
    const body = req.body || {};

    if (!body.event_name) {
      return res.status(400).json({ error: 'event_name required' });
    }

    // Extraer IP y User-Agent del cliente (Meta los necesita para matching)
    const fwd = req.headers['x-forwarded-for'] || '';
    const clientIp = fwd.split(',')[0].trim() || req.headers['x-real-ip'] || '';
    const userAgent = req.headers['user-agent'] || '';

    // Construir evento CAPI según especificación de Meta
    const event = {
      event_name: body.event_name,
      event_time: body.event_time || Math.floor(Date.now() / 1000),
      event_id: body.event_id, // CRÍTICO para deduplicación con Pixel
      event_source_url: body.event_source_url || '',
      action_source: 'website',
      user_data: {
        client_ip_address: clientIp,
        client_user_agent: userAgent
      },
      custom_data: body.custom_data || {}
    };

    // Cookies de Meta Pixel (mejoran match rate ~30%)
    if (body.fbp) event.user_data.fbp = body.fbp;
    if (body.fbc) event.user_data.fbc = body.fbc;

    // PII hasheada — solo si el evento la incluye (formularios, etc.)
    if (body.email)      event.user_data.em = [sha256(body.email)];
    if (body.phone)      event.user_data.ph = [sha256(body.phone.replace(/\D/g, ''))];
    if (body.first_name) event.user_data.fn = [sha256(body.first_name)];
    if (body.last_name)  event.user_data.ln = [sha256(body.last_name)];
    if (body.city)       event.user_data.ct = [sha256(body.city)];
    if (body.country)    event.user_data.country = [sha256(body.country)];

    // Test event code para debugging (opcional, lo quitamos cuando esté validado)
    const testEventCode = body.test_event_code;

    // Enviar a Meta CAPI
    const url = `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${TOKEN}`;
    const payload = {
      data: [event],
      partner_agent: 'infinity-legacy-vercel-capi-1.0'
    };
    if (testEventCode) payload.test_event_code = testEventCode;

    const metaResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const metaResult = await metaResponse.json();

    if (!metaResponse.ok) {
      console.error('[CAPI] Meta rejected event:', JSON.stringify(metaResult));
      return res.status(metaResponse.status).json({
        ok: false,
        error: 'Meta rejected event',
        meta: metaResult
      });
    }

    return res.status(200).json({
      ok: true,
      events_received: metaResult.events_received,
      fbtrace_id: metaResult.fbtrace_id
    });
  } catch (e) {
    console.error('[CAPI] Handler error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
