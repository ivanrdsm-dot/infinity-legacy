/*
 * Infinity Legacy — Instagram Messaging Webhook + AI Bot
 *
 * Recibe DMs de Instagram (@infinitylegacy.of) y los procesa con el
 * MISMO bot Claude que opera WhatsApp. Mensajes y leads quedan en
 * la misma tabla Supabase, distinguidos por `channel = 'instagram'`.
 *
 * Vars env requeridas (todas ya existen en Vercel):
 *   - WA_VERIFY_TOKEN          (mismo que WA — Meta usa el mismo para todos los webhooks)
 *   - WA_APP_SECRET            (mismo)
 *   - WA_ACCESS_TOKEN          (System User token con instagram_manage_messages)
 *   - IG_PAGE_ID               (Facebook Page ID donde está vinculada @infinitylegacy.of)
 *   - IG_BUSINESS_ACCOUNT_ID   (Instagram Business Account ID)
 *   - ANTHROPIC_API_KEY
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * Webhook setup en Meta:
 *   - App → Productos → Messenger → Webhooks
 *   - Callback URL: https://www.infinitylegacy.io/api/ig-webhook
 *   - Verify Token: el mismo WA_VERIFY_TOKEN
 *   - Subscribed fields para Instagram: messages, messaging_postbacks
 *   - Suscribir Page para que IG eventos lleguen al webhook
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import ws from 'ws';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

// Lazy-init shared with wa-webhook
let _SYSTEM_PROMPT = null;
function getSystemPrompt() {
  if (_SYSTEM_PROMPT) return _SYSTEM_PROMPT;
  try {
    _SYSTEM_PROMPT = fs.readFileSync(path.join(process.cwd(), 'api/wa-bot/system-prompt.md'), 'utf-8');
  } catch (e) {
    console.error('[IG] system prompt read failed:', e.message);
    _SYSTEM_PROMPT = 'Eres el Asistente Infinity Legacy.';
  }
  return _SYSTEM_PROMPT;
}

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws },
  });
  return _supabase;
}

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ─────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // GET = Meta verifica el webhook (usa IG_VERIFY_TOKEN dedicado, fallback a WA_VERIFY_TOKEN)
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected = process.env.IG_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN;
    if (mode === 'subscribe' && token === expected) {
      return res.status(200).send(challenge);
    }
    console.warn('[IG] Webhook verify failed:', { mode, gotToken: token ? '(set)' : '(empty)' });
    return res.status(403).send('Forbidden');
  }
  if (req.method !== 'POST') return res.status(405).end();

  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch (e) { return res.status(400).send('Bad Request'); }

  let parsedBody;
  try { parsedBody = JSON.parse(rawBody); }
  catch (e) {
    // Log failed parse to Supabase for debugging
    try {
      await getSupabase().from('system_state').upsert({
        key: 'last_ig_webhook',
        value: { error: 'JSON parse failed', raw: rawBody.substring(0, 2000), at: new Date().toISOString() },
      });
    } catch (_) {}
    return res.status(400).send('Invalid JSON');
  }

  // 🔍 Save EVERY received payload to Supabase for debugging
  try {
    await getSupabase().from('system_state').upsert({
      key: 'last_ig_webhook',
      value: {
        body: parsedBody,
        bodyLen: rawBody.length,
        headers: {
          'x-hub-signature-256': req.headers['x-hub-signature-256'] || null,
          'content-type': req.headers['content-type'] || null,
        },
        received_at: new Date().toISOString(),
      },
    });
  } catch (e) { /* don't block */ }

  const object = parsedBody?.object;
  // Nueva "Instagram API with Instagram Login" puede usar otros object names
  // Lo aceptamos todos por ahora y filtramos solo lo que NO es Instagram/Messenger
  const acceptedObjects = ['instagram', 'page', 'whatsapp_business_account'];
  if (object && !acceptedObjects.includes(object)) {
    console.log('[IG] Unknown object, skipping:', object);
    return res.status(200).send('OK');
  }

  // Wrap processing in robust try/catch + persist each step to Supabase
  const steps = [];
  const logStep = (name, data) => {
    steps.push({ step: name, data, at: new Date().toISOString() });
  };

  try {
    const entries = parsedBody.entry || [];
    logStep('entries_count', entries.length);
    for (const entry of entries) {
      logStep('entry_processing', { id: entry.id, keys: Object.keys(entry) });

      // Formato 1: entry.messaging
      const messaging = entry.messaging || [];
      logStep('messaging_count', messaging.length);
      for (const event of messaging) {
        try {
          logStep('processIgEvent_start', { sender: event.sender?.id, text: event.message?.text?.substring(0, 50) });
          await processIgEvent(event, entry);
          logStep('processIgEvent_done', { sender: event.sender?.id });
        } catch (e) {
          logStep('processIgEvent_ERROR', { error: e.message, stack: (e.stack || '').substring(0, 500) });
        }
      }

      // Formato 2: entry.changes (algunos eventos IG)
      const changes = entry.changes || [];
      for (const change of changes) {
        console.log('[IG] change field:', change.field, 'value keys:', Object.keys(change.value || {}));
        if (change.field === 'messages' || change.field === 'messaging_postbacks') {
          // value puede ser un solo evento o array
          if (change.value?.messages) {
            for (const m of change.value.messages) await processIgEvent(m, entry);
          } else if (Array.isArray(change.value)) {
            for (const v of change.value) await processIgEvent(v, entry);
          } else if (change.value) {
            // Adaptar al formato { sender, recipient, message } si viene anidado
            const synth = {
              sender: { id: change.value.from?.id || change.value.sender_id },
              recipient: { id: change.value.to?.id || change.value.recipient_id },
              message: { text: change.value.text || change.value.message?.text, mid: change.value.id },
              timestamp: change.value.timestamp,
            };
            await processIgEvent(synth, entry);
          }
        }
      }
    }
    // Save the full step log to Supabase for debugging
    try {
      await getSupabase().from('system_state').upsert({
        key: 'last_ig_processing',
        value: { steps, completed_at: new Date().toISOString() },
      });
    } catch (_) {}
    return res.status(200).send('OK');
  } catch (e) {
    logStep('handler_FATAL', { error: e.message, stack: (e.stack || '').substring(0, 500) });
    try {
      await getSupabase().from('system_state').upsert({
        key: 'last_ig_processing',
        value: { steps, fatal_error: e.message, at: new Date().toISOString() },
      });
    } catch (_) {}
    console.error('[IG] Handler error:', e.message, e.stack);
    return res.status(200).send('OK');
  }
}

// ─────────────────────────────────────────────────────────
// HELPER: insert message defensivo (reintenta sin columnas que no existen)
// ─────────────────────────────────────────────────────────
async function insertMessageRobust(payload) {
  let r = await getSupabase().from('messages').insert(payload);
  if (r.error && (r.error.code === '42703' || /column .* does not exist/i.test(r.error.message) || /could not find the .* column/i.test(r.error.message))) {
    // Quitar campos que no existen y reintentar
    const stripped = { ...payload };
    delete stripped.channel;
    r = await getSupabase().from('messages').insert(stripped);
  }
  if (r.error) console.error('[IG] message insert failed:', r.error.message);
  return r;
}

// ─────────────────────────────────────────────────────────
// PROCESS IG EVENT (DM, postback, etc.)
// ─────────────────────────────────────────────────────────
async function processIgEvent(event, entry) {
  // Skip echo events (mensajes que mandamos nosotros mismos)
  if (event.message?.is_echo) {
    console.log('[IG] echo skipped:', event.message?.mid);
    return;
  }

  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;
  const messageText = event.message?.text || event.postback?.payload || '[non-text IG]';
  const messageId = event.message?.mid || event.postback?.mid;
  const timestamp = event.timestamp;

  if (!senderId || !messageText) return;
  // Skip messages where sender == our IG account (shouldn't happen but safety)
  if (senderId === process.env.IG_BUSINESS_ACCOUNT_ID) return;

  console.log(`[IG] DM from ${senderId}: "${messageText.substring(0, 60)}"`);

  // 1. Upsert lead (channel = 'instagram')
  const { lead, isNew } = await upsertIgLead(senderId, messageText);

  // 2. Save inbound message (defensive: reintenta sin `channel` si la columna no existe)
  await insertMessageRobust({
    lead_id: lead.id,
    direction: 'inbound',
    sender_type: 'lead',
    body: messageText,
    message_type: 'text',
    wa_message_id: messageId,
    channel: 'instagram',
  });

  // 2.5 EXTRACT DATA from message + persist (email, phone, intent signals)
  await extractAndPersistLeadData(lead, messageText);

  // 3. Cancel pending follow-ups
  await getSupabase().from('follow_ups')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_reason: 'lead_responded' })
    .eq('lead_id', lead.id)
    .eq('status', 'pending');

  // 4. Bot paused?
  if (lead.bot_paused) {
    console.log(`[IG] bot paused for lead ${lead.id}`);
    return;
  }

  // 5. Budget cap diario (compartido con WA)
  const dailyBudget = parseFloat(process.env.CLAUDE_DAILY_BUDGET_USD || '3');
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: todayCost } = await getSupabase()
    .from('messages').select('llm_cost_usd').gte('created_at', since24h).not('llm_cost_usd', 'is', null);
  const spentToday = (todayCost || []).reduce((a, r) => a + parseFloat(r.llm_cost_usd || 0), 0);
  if (spentToday >= dailyBudget) {
    console.warn(`[IG] daily budget exceeded ($${spentToday.toFixed(2)})`);
    return;
  }

  // 6. Generate response with Claude (mismo system prompt, contexto adaptado)
  const response = await generateBotResponse(lead);
  const txt = (response.text || '').trim();
  const isMetaNoResponse = !txt || /^\*?\(?\s*no\s*response/i.test(txt) || txt.length < 5;
  if (!txt || isMetaNoResponse) return;

  // 7. Send via IG API
  await sendIgMessage(senderId, txt);

  // 8. Persist outbound (defensive insert)
  await insertMessageRobust({
    lead_id: lead.id,
    direction: 'outbound',
    sender_type: 'bot',
    body: txt,
    llm_model: 'claude-sonnet-4-5',
    llm_tokens_in: response.tokens_in,
    llm_tokens_out: response.tokens_out,
    llm_cost_usd: response.cost_usd,
    channel: 'instagram',
  });

  // 9. Schedule follow-ups
  await scheduleFollowUps(lead.id);

  // 10. Update lead state
  await getSupabase().from('leads').update({
    last_message_at: new Date().toISOString(),
    last_outbound_at: new Date().toISOString(),
    message_count: (lead.message_count || 0) + 1,
  }).eq('id', lead.id);
}

// ─────────────────────────────────────────────────────────
// UPSERT IG LEAD (channel = 'instagram')
// Usamos `ig_user_id` para identificar; si la columna no existe,
// caemos a `wa_phone` con prefijo 'ig:'.
// ─────────────────────────────────────────────────────────
async function upsertIgLead(igUserId, firstMessage) {
  // Try ig_user_id column first (new schema)
  let sel = await getSupabase()
    .from('leads')
    .select('*')
    .eq('ig_user_id', igUserId)
    .maybeSingle();

  if (sel.error && (sel.error.code === '42703' || /column .* does not exist/i.test(sel.error.message) || /could not find the .* column/i.test(sel.error.message))) {
    // Column doesn't exist → fall back to wa_phone with prefix
    sel = await getSupabase().from('leads').select('*').eq('wa_phone', 'ig:' + igUserId).maybeSingle();
  }

  if (sel.data) return { lead: sel.data, isNew: false };

  // Fetch IG profile info via new IG API
  let profileName = null;
  try {
    const igToken = process.env.IG_ACCESS_TOKEN;
    if (igToken) {
      const r = await fetch(`https://graph.instagram.com/v21.0/${igUserId}?fields=name,username&access_token=${igToken}`);
      const p = await r.json();
      profileName = p.name || p.username || null;
    }
  } catch (e) { /* ignore */ }

  const insertPayload = {
    wa_phone: 'ig:' + igUserId,  // fallback identifier
    wa_name: profileName,
    stage: 'INITIAL',
    source: 'instagram',
    first_message_at: new Date().toISOString(),
  };
  // Try to also include ig_user_id and channel if columns exist (Supabase ignora keys que no existen? No, falla)
  // Hacemos dos intentos: con columna ig_user_id, sin ella
  let ins = await getSupabase().from('leads').insert({ ...insertPayload, ig_user_id: igUserId, channel: 'instagram' }).select().single();
  if (ins.error && (ins.error.code === '42703' || /column .* does not exist/i.test(ins.error.message) || /could not find the .* column/i.test(ins.error.message))) {
    // Re-try without the new columns
    ins = await getSupabase().from('leads').insert(insertPayload).select().single();
  }
  if (ins.error) throw new Error('Supabase insert IG lead failed: ' + ins.error.message);
  return { lead: ins.data, isNew: true };
}

// ─────────────────────────────────────────────────────────
// GENERATE BOT RESPONSE (mismo flow que WA, slight channel context)
// ─────────────────────────────────────────────────────────
async function generateBotResponse(lead) {
  if ((lead.message_count || 0) > 40) {
    await getSupabase().from('follow_ups')
      .update({ status: 'cancelled', cancelled_reason: 'message_count_exceeded' })
      .eq('lead_id', lead.id).eq('status', 'pending');
  }

  const { data: history } = await getSupabase()
    .from('messages')
    .select('direction, sender_type, body, created_at')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(12)
    .then(r => ({ data: (r.data || []).reverse() }));

  const conversationHistory = (history || []).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: (m.body || '').substring(0, 600),
  }));

  const channelHint = `\n\n# 📷 CANAL: Instagram DM\nEste lead te escribe por Instagram (no WhatsApp). Reglas extra:\n- Tono ligeramente más casual (IG es más millennial/gen-z)\n- Menos formal pero igual de compliance-aware\n- Puedes referenciar contenido visual si el lead lo menciona\n- NO mandes URLs muy largas (Instagram a veces las trunca)\n- Si lead quiere agendar sesión, NO pidas teléfono — di que continúe la conversación ahí mismo en DM o que escriba a tu WhatsApp si prefieren`;

  const leadContext = `
# 📌 CONTEXTO DE ESTE LEAD ESPECÍFICO
- ID: ${lead.id}
- Canal: instagram (DM)
- IG/Identifier: ${lead.ig_user_id || lead.wa_phone}
- Nombre: ${lead.wa_name || 'desconocido'}
- Stage: ${lead.stage}
- Source: ${lead.source || 'instagram'}
- Mensajes previos: ${lead.message_count || 0}
${channelHint}

# 🔗 LINKS
- Calculadora: https://www.infinitylegacy.io/programa-acceso#calculadora
- Landing: https://www.infinitylegacy.io/programa-acceso

⚠️ Cuando lead pide agendar, di: "Le paso tu contacto a Iván del equipo. Él te escribe por este mismo DM (o por WhatsApp si prefieres) con horarios disponibles."`;

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 500, // IG mensajes más cortos que WA
    system: [
      { type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: leadContext },
    ],
    messages: conversationHistory.length ? conversationHistory : [{ role: 'user', content: '[Lead nuevo IG, primer mensaje]' }],
  });

  const text = response.content?.[0]?.text || '';
  const u = response.usage || {};
  const cost_usd = (
    (u.input_tokens || 0) * 3 +
    (u.output_tokens || 0) * 15 +
    (u.cache_creation_input_tokens || 0) * 3.75 +
    (u.cache_read_input_tokens || 0) * 0.30
  ) / 1_000_000;

  console.log(`[IG] Claude cost: $${cost_usd.toFixed(5)}`);
  return { text, tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0, cost_usd };
}

// ─────────────────────────────────────────────────────────
// EXTRACT LEAD DATA from message text (email, phone, name, intent)
// + Notify Iván vía WhatsApp cuando lead esté HOT
// ─────────────────────────────────────────────────────────
const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RX_MX = /\b(?:\+?52\s?1?\s?)?\(?(\d{2,3})\)?[\s.-]?(\d{3,4})[\s.-]?(\d{4})\b/;
const HIGH_INTENT_RX = /\b(ya\s*(quiero|estoy\s*listo|firmo|firma|me\s*decid)|vamos|agend[ae]mos|cuando\s*nos?\s*ve|me\s*interesa\s*mucho|s[íi]\s*claro\s*agend|listo\s*para\s*firma|cu[áa]ndo\s*podemos\s*hablar|qu[ée]\s*sigue|cu[áa]nto\s*es\s*el\s*m[íi]nimo|cu[áa]l\s*es\s*la\s*cuenta)/i;

async function extractAndPersistLeadData(lead, text) {
  if (!text) return;
  const updates = {};
  const signals = [];

  // 1. Email
  const emailMatch = text.match(EMAIL_RX);
  if (emailMatch && !lead.email) {
    updates.email = emailMatch[0].toLowerCase();
    signals.push(`📧 email: ${updates.email}`);
  }

  // 2. Phone (MX)
  const phoneMatch = text.match(PHONE_RX_MX);
  if (phoneMatch) {
    const digits = (phoneMatch[1] + phoneMatch[2] + phoneMatch[3]).replace(/\D/g, '');
    if (digits.length >= 10) {
      const fullPhone = digits.length === 10 ? '52' + digits : digits;
      if (fullPhone !== lead.wa_phone && !lead.lead_phone) {
        updates.lead_phone = fullPhone;
        signals.push(`📱 phone: +${fullPhone}`);
      }
    }
  }

  // 3. High intent signals
  if (HIGH_INTENT_RX.test(text)) {
    signals.push(`🔥 HIGH INTENT: "${text.substring(0, 80)}"`);
    updates.priority = 'urgent';
  }

  // 4. Apply updates to lead
  if (Object.keys(updates).length > 0) {
    let r = await getSupabase().from('leads').update(updates).eq('id', lead.id);
    // Defensive fallback if columns don't exist
    if (r.error && (/column .* does not exist/i.test(r.error.message) || /could not find the .* column/i.test(r.error.message))) {
      const stripped = { ...updates };
      delete stripped.email;
      delete stripped.lead_phone;
      if (Object.keys(stripped).length > 0) {
        await getSupabase().from('leads').update(stripped).eq('id', lead.id);
      }
    }
    // Merge into lead obj for downstream usage
    Object.assign(lead, updates);
  }

  // 5. Check if lead has reached "qualified" threshold and notify Iván
  await maybeNotifyIvan(lead, signals);
}

const NOTIFY_NUMBER = '525646665718'; // Iván personal

async function maybeNotifyIvan(lead, signals) {
  // Notify if: has at least email OR is high intent OR has explicit signals
  const shouldNotify = signals.length > 0;
  if (!shouldNotify) return;

  // Anti-spam: only notify once per lead per hour
  const lastKey = `notify_${lead.id}`;
  const { data: prevNotify } = await getSupabase()
    .from('system_state').select('value').eq('key', lastKey).maybeSingle();
  const lastAt = prevNotify?.value?.last_notified_at;
  if (lastAt && (Date.now() - new Date(lastAt).getTime() < 3600 * 1000)) {
    return; // notified within last hour
  }

  // Build message
  const channelEmoji = lead.channel === 'instagram' ? '📷 IG' : '💬 WA';
  const lines = [
    `🚨 LEAD ${lead.priority === 'urgent' ? 'CALIENTE' : 'NUEVA SEÑAL'}`,
    `${channelEmoji} ${lead.wa_name || 'Sin nombre'} (${lead.wa_phone})`,
    `Stage: ${lead.stage} · ${lead.message_count || 0} msgs`,
    ``,
    ...signals.map(s => `• ${s}`),
    ``,
    `Lead ID: ${lead.id.substring(0, 8)}…`,
    `Abrir en OS: https://www.infinitylegacy.io/os/#inbox`,
  ];
  const message = lines.join('\n');

  // Send via WhatsApp using the test number (or whichever is configured)
  try {
    await fetch(`https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
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
    });
    // Record notification
    await getSupabase().from('system_state').upsert({
      key: lastKey,
      value: { last_notified_at: new Date().toISOString(), signals },
    });
    console.log(`[IG] Notified Iván about lead ${lead.id}`);
  } catch (e) {
    console.error('[IG] Notify Iván failed:', e.message);
  }
}

// ─────────────────────────────────────────────────────────
// SEND IG MESSAGE via Graph API
// ─────────────────────────────────────────────────────────
async function sendIgMessage(recipientId, text) {
  // "Instagram API with Instagram Login" (nueva 2024): IG_ACCESS_TOKEN dedicado
  // Endpoint: https://graph.instagram.com/v21.0/me/messages (NO graph.facebook.com)
  const accessToken = process.env.IG_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('[IG send] IG_ACCESS_TOKEN missing');
    return;
  }
  const url = `https://graph.instagram.com/v21.0/me/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });
  const respText = await resp.text();
  if (!resp.ok) {
    console.error('[IG send] failed:', resp.status, respText);
    return { error: true, body: respText };
  }
  console.log('[IG send] success →', recipientId);
  try { return JSON.parse(respText); } catch (e) { return { raw: respText }; }
}

// ─────────────────────────────────────────────────────────
// SCHEDULE FOLLOW-UPS (mismo que WA)
// ─────────────────────────────────────────────────────────
async function scheduleFollowUps(leadId) {
  const now = Date.now();
  const schedule = [
    { type: '10min', delay: 10 * 60 * 1000 },
    { type: '30min', delay: 30 * 60 * 1000 },
    { type: '1day', delay: 24 * 60 * 60 * 1000 },
    { type: '3day', delay: 3 * 24 * 60 * 60 * 1000 },
    { type: '7day', delay: 7 * 24 * 60 * 60 * 1000 },
  ];
  const inserts = schedule.map(s => ({
    lead_id: leadId,
    scheduled_for: new Date(now + s.delay).toISOString(),
    followup_type: s.type,
    status: 'pending',
  }));
  await getSupabase().from('follow_ups').insert(inserts);
}

// Force-deploy marker: build $(date +%s)
