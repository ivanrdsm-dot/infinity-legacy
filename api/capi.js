/*
 * Infinity Legacy — Conversions API server-side endpoint
 *
 * Recibe eventos del navegador (POST desde tracking.js) y los reenvía
 * a Meta Conversions API server-to-server. Bypass de adblockers/iOS.
 *
 * Variables de entorno requeridas (Vercel):
 *   - PIXEL_ID           (plain text)
 *   - CAPI_ACCESS_TOKEN  (encrypted)
 */

import crypto from 'node:crypto';

// Hash SHA-256 (Meta requiere PII hasheada para privacy)
function sha256(value) {
  if (!value) return null;
  return crypto
    .createHash('sha256')
    .update(String(value).toLowerCase().trim())
    .digest('hex');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PIXEL_ID = process.env.PIXEL_ID;
  const TOKEN = process.env.CAPI_ACCESS_TOKEN;
  if (!PIXEL_ID || !TOKEN) {
    return res.status(500).json({ error: 'Server env not configured' });
  }

  try {
    const body = req.body || {};
    if (!body.event_name) return res.status(400).json({ error: 'event_name required' });

    const fwd = req.headers['x-forwarded-for'] || '';
    const clientIp = fwd.split(',')[0].trim() || req.headers['x-real-ip'] || '';
    const userAgent = req.headers['user-agent'] || '';

    const event = {
      event_name: body.event_name,
      event_time: body.event_time || Math.floor(Date.now() / 1000),
      event_id: body.event_id,
      event_source_url: body.event_source_url || '',
      action_source: 'website',
      user_data: {
        client_ip_address: clientIp,
        client_user_agent: userAgent,
      },
      custom_data: body.custom_data || {},
    };

    if (body.fbp) event.user_data.fbp = body.fbp;
    if (body.fbc) event.user_data.fbc = body.fbc;
    if (body.email) event.user_data.em = [sha256(body.email)];
    if (body.phone) event.user_data.ph = [sha256(body.phone.replace(/\D/g, ''))];
    if (body.first_name) event.user_data.fn = [sha256(body.first_name)];
    if (body.last_name) event.user_data.ln = [sha256(body.last_name)];
    if (body.city) event.user_data.ct = [sha256(body.city)];
    if (body.country) event.user_data.country = [sha256(body.country)];

    const url = `https://graph.facebook.com/v21.0/${PIXEL_ID}/events?access_token=${TOKEN}`;
    const payload = {
      data: [event],
      partner_agent: 'infinity-legacy-vercel-capi-1.0',
    };
    if (body.test_event_code) payload.test_event_code = body.test_event_code;

    const metaResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const metaResult = await metaResponse.json();

    if (!metaResponse.ok) {
      console.error('[CAPI] Meta rejected:', JSON.stringify(metaResult));
      return res.status(metaResponse.status).json({
        ok: false,
        error: 'Meta rejected event',
        meta: metaResult,
      });
    }

    return res.status(200).json({
      ok: true,
      events_received: metaResult.events_received,
      fbtrace_id: metaResult.fbtrace_id,
    });
  } catch (e) {
    console.error('[CAPI] Handler error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
