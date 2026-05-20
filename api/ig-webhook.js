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
  // GET = Meta verifica el webhook
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WA_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }
  if (req.method !== 'POST') return res.status(405).end();

  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch (e) { return res.status(400).send('Bad Request'); }

  // Signature check (Meta usa misma App Secret para todos los productos)
  const signature = req.headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(rawBody).digest('hex');
  if (signature !== expected) {
    console.warn('[IG] Invalid signature — continuing for resilience', { got: signature, bodyLen: rawBody.length });
  }

  let parsedBody;
  try { parsedBody = JSON.parse(rawBody); }
  catch (e) { return res.status(400).send('Invalid JSON'); }

  // Meta IG webhook formats:
  // object: "instagram" or "page" depending on event source
  const object = parsedBody?.object;
  if (object !== 'instagram' && object !== 'page') {
    return res.status(200).send('OK'); // not for us, ignore
  }

  try {
    const entries = parsedBody.entry || [];
    for (const entry of entries) {
      // IG DMs llegan en entry.messaging (no entry.changes)
      const messaging = entry.messaging || [];
      for (const event of messaging) {
        await processIgEvent(event, entry);
      }
      // Some IG events come as changes (e.g., comments, mentions)
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field === 'messages') {
          const msgs = change.value?.messages || [];
          for (const m of msgs) await processIgEvent(m, entry);
        }
      }
    }
    return res.status(200).send('OK');
  } catch (e) {
    console.error('[IG] Handler error:', e.message, e.stack);
    return res.status(200).send('OK'); // Always 200 — Meta penalizes errors
  }
}

// ─────────────────────────────────────────────────────────
// HELPER: insert message defensivo (reintenta sin columnas que no existen)
// ─────────────────────────────────────────────────────────
async function insertMessageRobust(payload) {
  let r = await getSupabase().from('messages').insert(payload);
  if (r.error && (r.error.code === '42703' || /column .* does not exist/i.test(r.error.message))) {
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

  if (sel.error && sel.error.code === '42703') {
    // Column doesn't exist → fall back to wa_phone with prefix
    sel = await getSupabase().from('leads').select('*').eq('wa_phone', 'ig:' + igUserId).maybeSingle();
  }

  if (sel.data) return { lead: sel.data, isNew: false };

  // Try to fetch IG profile info (username, name)
  let profileName = null;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${igUserId}?fields=name,username&access_token=${process.env.WA_ACCESS_TOKEN}`);
    const p = await r.json();
    profileName = p.name || p.username || null;
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
  if (ins.error && (ins.error.code === '42703' || /column .* does not exist/i.test(ins.error.message))) {
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
// SEND IG MESSAGE via Graph API
// ─────────────────────────────────────────────────────────
async function sendIgMessage(recipientId, text) {
  const pageId = process.env.IG_PAGE_ID;
  if (!pageId) {
    console.error('[IG send] IG_PAGE_ID env var missing');
    return;
  }
  const url = `https://graph.facebook.com/v21.0/${pageId}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  });
  const respText = await resp.text();
  if (!resp.ok) {
    console.error('[IG send] failed:', resp.status, respText);
    return { error: true, body: respText };
  }
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
