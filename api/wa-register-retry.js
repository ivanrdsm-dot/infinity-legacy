/*
 * Infinity Legacy — /register retry helper
 *
 * Endpoint para reintentar /register del número real cuando Meta lo libere.
 * Si /register tiene éxito → actualiza WA_PHONE_NUMBER_ID lógicamente (queda
 * en la respuesta), notifica vía WhatsApp a Iván, devuelve OK al frontend.
 *
 * Auth: DASHBOARD_TOKEN como query param.
 */

const PHONE_ID_REAL = '1058413820699577';     // 5566253065
const PHONE_ID_TEST = '1090294950838250';     // +1 555 175 3968 (fallback)
const NOTIFY_NUMBER = '525646665718';         // Iván personal

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const token = (req.query.t || req.headers['x-dash-token'] || '').trim();
  if (!process.env.DASHBOARD_TOKEN) return res.status(500).json({ error: 'DASHBOARD_TOKEN missing' });
  if (token !== process.env.DASHBOARD_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  if (!process.env.WA_ACCESS_TOKEN) return res.status(500).json({ error: 'WA_ACCESS_TOKEN missing' });

  // Check current status first
  const statusUrl = `https://graph.facebook.com/v21.0/${PHONE_ID_REAL}?fields=status,code_verification_status,verified_name,quality_rating`;
  const statusResp = await fetch(statusUrl, {
    headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` },
  });
  const statusData = await statusResp.json();

  // If already CONNECTED, nothing to do
  if (statusData.status === 'CONNECTED') {
    return res.status(200).json({
      ok: true,
      already_connected: true,
      phone_status: statusData,
      message: 'El número 5566253065 ya está CONNECTED y operativo.',
    });
  }

  // Attempt /register
  const registerResp = await fetch(`https://graph.facebook.com/v21.0/${PHONE_ID_REAL}/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      pin: process.env.WA_2FA_PIN || '123456',
    }),
  });
  const registerData = await registerResp.json();

  if (registerResp.ok && registerData.success !== false) {
    // 🎉 ÉXITO — notifica a Iván vía WhatsApp
    try {
      // Use whichever phone_id is currently working to send the notification
      const senderPhoneId = process.env.WA_PHONE_NUMBER_ID || PHONE_ID_TEST;
      await fetch(`https://graph.facebook.com/v21.0/${senderPhoneId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: NOTIFY_NUMBER,
          type: 'text',
          text: {
            body: '🎉 ¡5566253065 ya está CONNECTED en Cloud API!\n\nEl bot se va a activar automático cuando confirmes el switch en /os/#settings.\n\nO yo lo puedo hacer ahora si me avisas.',
          },
        }),
      });
    } catch (e) {
      console.error('[register-retry] notify failed:', e.message);
    }

    return res.status(200).json({
      ok: true,
      registered: true,
      phone_status: { ...statusData, status: 'CONNECTED' },
      register_response: registerData,
      next_step: 'Update WA_PHONE_NUMBER_ID to ' + PHONE_ID_REAL + ' in Vercel and redeploy.',
    });
  }

  // Failed — return the error so UI can show
  return res.status(200).json({
    ok: false,
    error: registerData.error || registerData,
    phone_status: statusData,
    suggestion: registerData.error?.error_subcode === 2388001
      ? 'Meta server-side caché. Espera 1-6 hrs y reintenta. O verifica que no quede ninguna app WhatsApp/Business instalada en NINGÚN dispositivo (iPhone, iPad, Mac con WhatsApp Desktop).'
      : 'Error desconocido. Revisa el detalle.',
  });
}
