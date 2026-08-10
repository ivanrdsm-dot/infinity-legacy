/*
 * Infinity Legacy — Meta Business Verification monitor
 *
 * Endpoint que corre cada 6 horas via Vercel Cron. Chequea el status
 * de Business Verification de la WABA "Infinity Legacy" (1466393031364279).
 * Cuando cambia a algo distinto de "pending" (probable "verified" o
 * "expired"), manda WhatsApp a Iván.
 *
 * Auth: misma header X-Cron-Secret que wa-cron-followup.
 *
 * Env vars:
 *   - WA_ACCESS_TOKEN (system user token con whatsapp_business_management)
 *   - WA_PHONE_NUMBER_ID (para enviar notificación a Iván)
 *   - IVAN_NOTIFY_NUMBER (525646665718)
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (para guardar last status)
 *   - CRON_SECRET (auth)
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

const WABA_ID = '1466393031364279'; // Infinity Legacy WABA
const NOTIFY_NUMBER = '525646665718'; // Iván personal

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }, realtime: { transport: ws },
  });
  return _supabase;
}

export default async function handler(req, res) {
  // Vercel cron auth
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end('Unauthorized');
  }

  if (!process.env.WA_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'WA_ACCESS_TOKEN missing' });
  }

  try {
    // 1. Get current WABA status from Meta
    const r = await fetch(
      `https://graph.facebook.com/v21.0/${WABA_ID}?fields=id,name,business_verification_status,account_review_status`,
      { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}` } }
    );
    const data = await r.json();

    const currentVerifyStatus = data.business_verification_status || 'unknown';
    const currentReviewStatus = data.account_review_status || 'unknown';
    const checkedAt = new Date().toISOString();

    // 2. Read previous state from Supabase
    const { data: prev } = await getSupabase()
      .from('system_state')
      .select('value, updated_at')
      .eq('key', 'meta_verify_status')
      .maybeSingle();

    const prevValue = prev?.value || {};
    const prevVerify = prevValue.business_verification_status || null;
    const lastNotifiedAt = prevValue.last_notified_at || null;

    console.log(`[meta-verify] current=${currentVerifyStatus}/${currentReviewStatus} prev=${prevVerify}`);

    // 3. Decide if we should notify
    let shouldNotify = false;
    let notifyReason = '';

    // Caso 1: cambió de pending a algo distinto
    if (prevVerify === 'pending' && currentVerifyStatus !== 'pending') {
      shouldNotify = true;
      notifyReason = 'status_changed';
    }
    // Caso 2: status es positivo y no hemos notificado en últimas 24h
    if (currentVerifyStatus === 'verified' || currentVerifyStatus === 'approved') {
      const sinceLastNotify = lastNotifiedAt ? (Date.now() - new Date(lastNotifiedAt).getTime()) : Infinity;
      if (sinceLastNotify > 24 * 3600 * 1000) {
        shouldNotify = true;
        notifyReason = notifyReason || 'verified_reminder';
      }
    }

    // 4. Send notification if needed
    let notifyResult = null;
    if (shouldNotify) {
      const message = currentVerifyStatus === 'verified' || currentVerifyStatus === 'approved'
        ? `🎉 ¡META APROBÓ BUSINESS VERIFICATION!

Status: ${currentVerifyStatus}
Account Review: ${currentReviewStatus}

Próximo paso (5 min tu trabajo):
1. Ve a Meta Business Manager → WhatsApp → WABA "Infinity Legacy"
2. Agrega de nuevo el +52 55 6625 3065 (porque el ID anterior fue eliminado)
3. Recibe nuevo phone_number_id
4. Pásamelo y activo bot en producción real en 30 seg

Link directo:
https://business.facebook.com/wa/manage/phone-numbers/?waba_id=${WABA_ID}`
        : `⚠️ Cambio en Business Verification

Status: ${currentVerifyStatus}
Account Review: ${currentReviewStatus}

Revisa Meta Business Suite para más detalles:
https://business.facebook.com/security/

Si Meta pidió info adicional, súbela cuanto antes para que continúe la revisión.`;

      try {
        const sendR = await fetch(
          `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              messaging_product: 'whatsapp',
              to: NOTIFY_NUMBER,
              type: 'text',
              text: { body: message },
            }),
          }
        );
        notifyResult = await sendR.json();
      } catch (e) {
        notifyResult = { error: e.message };
      }
    }

    // 5. Persist current state
    const newValue = {
      business_verification_status: currentVerifyStatus,
      account_review_status: currentReviewStatus,
      checked_at: checkedAt,
      last_notified_at: shouldNotify ? checkedAt : lastNotifiedAt,
    };
    await getSupabase()
      .from('system_state')
      .upsert({ key: 'meta_verify_status', value: newValue, updated_at: checkedAt });

    return res.status(200).json({
      ok: true,
      currentVerifyStatus,
      currentReviewStatus,
      prevVerify,
      shouldNotify,
      notifyReason,
      notifyResult,
      checkedAt,
    });
  } catch (e) {
    console.error('[meta-verify] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
