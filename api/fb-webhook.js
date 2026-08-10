/*
 * Infinity Legacy — Facebook Messenger Webhook + Majo Bot
 *
 * Recibe DMs de la Page de Facebook "Infinity Legacy" y los procesa con
 * el MISMO bot Majo (Claude Sonnet 4.5) que opera Instagram y WhatsApp.
 *
 * Diferencias clave con ig-webhook:
 *   - Send endpoint: POST graph.facebook.com/v21.0/me/messages (con Page Access Token)
 *   - Object recibido: "page" (no "instagram")
 *   - Usa FB_PAGE_ACCESS_TOKEN (no IG_ACCESS_TOKEN)
 *   - Channel = 'messenger'
 *
 * Env vars requeridas (Vercel):
 *   - FB_PAGE_ACCESS_TOKEN  (Page Access Token de "Infinity Legacy")
 *   - FB_VERIFY_TOKEN       (random secret para validar webhook)
 *   - FB_PAGE_ID            (1097057583490606)
 *   - ANTHROPIC_API_KEY     (ya existe)
 *   - SUPABASE_URL + SERVICE_ROLE_KEY (ya existen)
 *   - WA_APP_SECRET         (Meta firma webhooks con esto)
 *
 * Setup en Meta App:
 *   1. Add product "Messenger"
 *   2. Webhooks section → Callback URL: https://www.infinitylegacy.io/api/fb-webhook
 *   3. Verify Token: el valor de FB_VERIFY_TOKEN
 *   4. Subscribe Page "Infinity Legacy" with fields: messages, messaging_postbacks
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import ws from 'ws';
import { recalcAndPersistScore } from '../lib/wa-bot/lead-scoring.js';
import { auditMessage, shouldBlock } from '../lib/wa-bot/compliance-audit.js';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

let _SYSTEM_PROMPT = null;
function getSystemPrompt() {
  if (_SYSTEM_PROMPT) return _SYSTEM_PROMPT;
  try {
    _SYSTEM_PROMPT = fs.readFileSync(path.join(process.cwd(), 'api/wa-bot/system-prompt.md'), 'utf-8');
  } catch (e) {
    _SYSTEM_PROMPT = 'Eres Majo, asistente de Infinity Legacy.';
  }
  return _SYSTEM_PROMPT;
}

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }, realtime: { transport: ws },
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
  // GET = Meta verifies the webhook
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    const expected = process.env.FB_VERIFY_TOKEN;
    if (mode === 'subscribe' && token === expected) {
      return res.status(200).send(challenge);
    }
    console.warn('[FB] Webhook verify failed:', { mode, gotToken: token ? '(set)' : '(empty)' });
    return res.status(403).send('Forbidden');
  }

  if (req.method !== 'POST') return res.status(405).end();

  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch (e) { return res.status(400).send('Bad Request'); }

  let parsedBody;
  try { parsedBody = JSON.parse(rawBody); }
  catch (e) { return res.status(400).send('Invalid JSON'); }

  // Save raw payload for debugging (system_state.last_fb_webhook)
  try {
    await getSupabase().from('system_state').upsert({
      key: 'last_fb_webhook',
      value: { body: parsedBody, bodyLen: rawBody.length, received_at: new Date().toISOString() },
    });
  } catch (e) {}

  const object = parsedBody?.object;
  // Messenger envia object='page'
  if (object !== 'page') {
    return res.status(200).send('OK');
  }

  const steps = [];
  const logStep = (name, data) => steps.push({ step: name, data, at: new Date().toISOString() });

  try {
    const entries = parsedBody.entry || [];
    logStep('entries_count', entries.length);
    for (const entry of entries) {
      const messaging = entry.messaging || [];
      logStep('messaging_count', messaging.length);
      for (const event of messaging) {
        try {
          logStep('processFbEvent_start', { sender: event.sender?.id, text: event.message?.text?.substring(0, 60) });
          await processFbEvent(event, entry);
          logStep('processFbEvent_done', { sender: event.sender?.id });
        } catch (e) {
          logStep('processFbEvent_ERROR', { error: e.message, stack: (e.stack || '').substring(0, 500) });
        }
      }
    }
    try {
      await getSupabase().from('system_state').upsert({
        key: 'last_fb_processing',
        value: { steps, completed_at: new Date().toISOString() },
      });
    } catch (_) {}
    return res.status(200).send('OK');
  } catch (e) {
    console.error('[FB] Handler error:', e.message, e.stack);
    return res.status(200).send('OK');
  }
}

// ─────────────────────────────────────────────────────────
// Helper: insert message defensivo
// ─────────────────────────────────────────────────────────
async function insertMessageRobust(payload) {
  let r = await getSupabase().from('messages').insert(payload);
  if (r.error && (r.error.code === '42703' || /column .* does not exist/i.test(r.error.message) || /could not find the .* column/i.test(r.error.message))) {
    const stripped = { ...payload };
    delete stripped.channel;
    r = await getSupabase().from('messages').insert(stripped);
  }
  if (r.error) console.error('[FB] insert msg failed:', r.error.message);
}

// ─────────────────────────────────────────────────────────
// PROCESS FB EVENT (Messenger DM, postback, etc.)
// ─────────────────────────────────────────────────────────
async function processFbEvent(event, entry) {
  if (event.message?.is_echo) return; // skip our own messages

  const senderId = event.sender?.id;
  const recipientId = event.recipient?.id;
  const messageId = event.message?.mid || event.postback?.mid;
  const timestamp = event.timestamp;

  if (!senderId) return;
  // Skip messages where sender == our Page
  if (senderId === process.env.FB_PAGE_ID) return;

  // Detect text vs non-text
  const textRaw = event.message?.text || event.postback?.payload || event.postback?.title;
  const hasText = textRaw && textRaw.trim().length > 0;
  const attachments = event.message?.attachments || [];
  const hasAttachment = attachments.length > 0;
  const isReaction = !!event.reaction;

  if (!hasText && !hasAttachment && !isReaction) return;

  // Canned reply for non-text attachments
  if (!hasText && hasAttachment) {
    const type = attachments[0]?.type || 'archivo';
    const cannedReply = `Recibí tu ${type} 🙂 De este lado solo puedo conversar por texto. Cuéntame con palabras qué te interesa del Programa de Acceso y te ayudo con todo el detalle.`;
    try { await sendFbMessage(senderId, cannedReply); } catch (e) { console.error('[FB] canned send failed:', e.message); }
    return;
  }

  if (isReaction) return; // skip emoji reactions
  if (!hasText) return;

  const messageText = textRaw.trim();

  // Idempotency check
  if (messageId) {
    try {
      const { data: existing } = await getSupabase()
        .from('messages').select('id').eq('wa_message_id', messageId).maybeSingle();
      if (existing) { console.log(`[FB] Duplicate ${messageId} — skipping`); return; }
    } catch (e) {}
  }

  console.log(`[FB] DM from ${senderId}: "${messageText.substring(0, 60)}"`);

  // 1. Upsert lead (channel = 'messenger')
  const { lead, isNew } = await upsertFbLead(senderId, messageText);

  // 2. Save inbound
  await insertMessageRobust({
    lead_id: lead.id, direction: 'inbound', sender_type: 'lead',
    body: messageText, message_type: 'text',
    wa_message_id: messageId, channel: 'messenger',
  });

  // 2.5 Extract data
  await extractAndPersistLeadData(lead, messageText);

  // 2.6 Recalc score
  try {
    const scoreResult = await recalcAndPersistScore(getSupabase(), lead);
    lead.lead_score = scoreResult.score;
    lead.tier = scoreResult.tier;
    console.log(`[FB] Lead ${lead.id} score: ${scoreResult.score} (${scoreResult.tier_emoji} ${scoreResult.tier})`);
  } catch (e) { console.error('[FB] score calc failed:', e.message); }

  // 3. Cancel pending follow-ups
  await getSupabase().from('follow_ups')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_reason: 'lead_responded' })
    .eq('lead_id', lead.id).eq('status', 'pending');

  if (lead.bot_paused) return;

  // 4. Budget cap
  const dailyBudget = parseFloat(process.env.CLAUDE_DAILY_BUDGET_USD || '3');
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: todayCost } = await getSupabase()
    .from('messages').select('llm_cost_usd').gte('created_at', since24h).not('llm_cost_usd', 'is', null);
  const spentToday = (todayCost || []).reduce((a, r) => a + parseFloat(r.llm_cost_usd || 0), 0);
  if (spentToday >= dailyBudget) {
    console.warn(`[FB] budget exceeded $${spentToday.toFixed(2)}`);
    return;
  }

  // 5. Generate response with Claude
  const response = await generateBotResponse(lead);
  const txt = (response.text || '').trim();
  if (!txt || txt.length < 5) return;

  // 5.5 Compliance audit
  const audit = await auditMessage(getAnthropic(), txt);
  if (shouldBlock(audit)) {
    console.warn(`[FB] 🚨 BLOCKED message for lead ${lead.id}: ${audit.severity}`, audit.violations);
    await insertMessageRobust({
      lead_id: lead.id, direction: 'outbound', sender_type: 'bot',
      body: '[BLOCKED BY COMPLIANCE] ' + txt,
      llm_model: 'claude-sonnet-4-5+blocked',
      llm_cost_usd: (response.cost_usd || 0) + (audit.audit_cost_usd || 0),
      channel: 'messenger',
    });
    return;
  }

  // 6. Send via Messenger API
  await sendFbMessage(senderId, txt);

  // 7. Persist outbound
  await insertMessageRobust({
    lead_id: lead.id, direction: 'outbound', sender_type: 'bot',
    body: txt, llm_model: 'claude-sonnet-4-5',
    llm_tokens_in: response.tokens_in, llm_tokens_out: response.tokens_out,
    llm_cost_usd: (response.cost_usd || 0) + (audit.audit_cost_usd || 0),
    channel: 'messenger',
  });

  // 8. Schedule follow-ups
  await scheduleFollowUps(lead.id);

  // 9. Update lead counters
  await getSupabase().from('leads').update({
    last_message_at: new Date().toISOString(),
    last_outbound_at: new Date().toISOString(),
    message_count: (lead.message_count || 0) + 1,
  }).eq('id', lead.id);
}

// ─────────────────────────────────────────────────────────
// SEND Messenger message via Graph API
// ─────────────────────────────────────────────────────────
async function sendFbMessage(recipientId, text) {
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  if (!token) {
    console.error('[FB send] FB_PAGE_ACCESS_TOKEN missing');
    return;
  }
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
      messaging_type: 'RESPONSE',
    }),
  });
  const respText = await resp.text();
  if (!resp.ok) {
    console.error('[FB send] failed:', resp.status, respText);
    return { error: true, body: respText };
  }
  console.log('[FB send] success →', recipientId);
  try { return JSON.parse(respText); } catch (e) { return { raw: respText }; }
}

// ─────────────────────────────────────────────────────────
// UPSERT FB Lead
// ─────────────────────────────────────────────────────────
async function upsertFbLead(senderId, firstMessage) {
  // Try by wa_phone prefix first (we use 'fb:<senderId>' as primary key)
  let sel = await getSupabase().from('leads').select('*').eq('wa_phone', 'fb:' + senderId).maybeSingle();
  if (sel.data) return { lead: sel.data, isNew: false };

  // Try to fetch FB profile info
  let profileName = null;
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${senderId}?fields=name,first_name,last_name&access_token=${process.env.FB_PAGE_ACCESS_TOKEN}`);
    const p = await r.json();
    profileName = p.name || `${p.first_name||''} ${p.last_name||''}`.trim() || null;
  } catch (e) {}

  const payload = {
    wa_phone: 'fb:' + senderId,
    wa_name: profileName,
    stage: 'INITIAL',
    source: 'messenger',
    first_message_at: new Date().toISOString(),
  };
  let ins = await getSupabase().from('leads').insert({ ...payload, channel: 'messenger' }).select().single();
  if (ins.error && (ins.error.code === '42703' || /column .* does not exist/i.test(ins.error.message) || /could not find the .* column/i.test(ins.error.message))) {
    ins = await getSupabase().from('leads').insert(payload).select().single();
  }
  if (ins.error) throw new Error('upsert FB lead failed: ' + ins.error.message);
  return { lead: ins.data, isNew: true };
}

// ─────────────────────────────────────────────────────────
// GENERATE bot response (mismo flow, channel-aware)
// ─────────────────────────────────────────────────────────
async function generateBotResponse(lead) {
  if ((lead.message_count || 0) > 40) {
    await getSupabase().from('follow_ups')
      .update({ status: 'cancelled', cancelled_reason: 'message_count_exceeded' })
      .eq('lead_id', lead.id).eq('status', 'pending');
  }

  const { data: history } = await getSupabase()
    .from('messages').select('direction, body, created_at')
    .eq('lead_id', lead.id).order('created_at', { ascending: false }).limit(12)
    .then(r => ({ data: (r.data || []).reverse() }));

  const conversationHistory = (history || []).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: (m.body || '').substring(0, 600),
  }));

  const leadContext = `
# 📌 CONTEXTO LEAD
- ID: ${lead.id} · Identifier: ${lead.wa_phone} · Name: ${lead.wa_name || 'desconocido'}
- Stage: ${lead.stage} · Mensajes previos: ${lead.message_count || 0}
- Canal: Messenger (Facebook)
- Score actual: ${lead.lead_score || 0}/100

🔗 Calculadora: https://www.infinitylegacy.io/programa-acceso#calculadora

⚠️ Cuando lead pida agendar: "Le paso tu contacto a Iván del equipo. Te escribe en <30 min con horarios."`;

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: [
      { type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: leadContext },
    ],
    messages: conversationHistory.length ? conversationHistory : [{ role: 'user', content: '[Lead nuevo en Messenger]' }],
  });

  const text = response.content?.[0]?.text || '';
  const u = response.usage || {};
  const cost_usd = (
    (u.input_tokens || 0) * 3 + (u.output_tokens || 0) * 15 +
    (u.cache_creation_input_tokens || 0) * 3.75 + (u.cache_read_input_tokens || 0) * 0.30
  ) / 1_000_000;
  console.log(`[FB] Claude cost: $${cost_usd.toFixed(5)}`);
  return { text, tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0, cost_usd };
}

// ─────────────────────────────────────────────────────────
// Extract data + notify Iván (reusa lógica de ig-webhook)
// ─────────────────────────────────────────────────────────
const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RX_MX = /\b(?:\+?52\s?1?\s?)?\(?(\d{2,3})\)?[\s.-]?(\d{3,4})[\s.-]?(\d{4})\b/;
const HIGH_INTENT_RX = /\b(ya\s*(quiero|estoy\s*listo|firmo|firma|me\s*decid)|vamos|agend[ae]mos|cuando\s*nos?\s*ve|me\s*interesa\s*mucho|s[íi]\s*claro\s*agend|listo\s*para\s*firma|cu[áa]ndo\s*podemos\s*hablar|qu[ée]\s*sigue|cu[áa]nto\s*es\s*el\s*m[íi]nimo|cu[áa]l\s*es\s*la\s*cuenta)/i;
const NOTIFY_NUMBER = '525646665718';

async function extractAndPersistLeadData(lead, text) {
  if (!text) return;
  const updates = {};
  const signals = [];

  const emailMatch = text.match(EMAIL_RX);
  if (emailMatch && !lead.email) {
    updates.email = emailMatch[0].toLowerCase();
    signals.push(`📧 email: ${updates.email}`);
  }

  const phoneMatch = text.match(PHONE_RX_MX);
  if (phoneMatch) {
    const digits = (phoneMatch[1] + phoneMatch[2] + phoneMatch[3]).replace(/\D/g, '');
    if (digits.length >= 10) {
      const fullPhone = digits.length === 10 ? '52' + digits : digits;
      if (!lead.lead_phone) {
        updates.lead_phone = fullPhone;
        signals.push(`📱 phone: +${fullPhone}`);
      }
    }
  }

  if (HIGH_INTENT_RX.test(text)) {
    signals.push(`🔥 HIGH INTENT: "${text.substring(0, 80)}"`);
    updates.priority = 'urgent';
  }

  if (Object.keys(updates).length > 0) {
    let r = await getSupabase().from('leads').update(updates).eq('id', lead.id);
    if (r.error && (/column .* does not exist/i.test(r.error.message) || /could not find the .* column/i.test(r.error.message))) {
      const stripped = { ...updates }; delete stripped.email; delete stripped.lead_phone;
      if (Object.keys(stripped).length > 0) await getSupabase().from('leads').update(stripped).eq('id', lead.id);
    }
    Object.assign(lead, updates);
  }

  if (signals.length > 0) await maybeNotifyIvan(lead, signals);
}

async function maybeNotifyIvan(lead, signals) {
  const lastKey = `notify_${lead.id}`;
  const { data: prevNotify } = await getSupabase().from('system_state').select('value').eq('key', lastKey).maybeSingle();
  const lastAt = prevNotify?.value?.last_notified_at;
  if (lastAt && (Date.now() - new Date(lastAt).getTime() < 3600 * 1000)) return;

  const lines = [
    `🚨 LEAD ${lead.priority === 'urgent' ? 'CALIENTE' : 'NUEVA SEÑAL'} (Messenger)`,
    `💬 ${lead.wa_name || 'Sin nombre'} (${lead.wa_phone})`,
    `Stage: ${lead.stage} · ${lead.message_count || 0} msgs · Score ${lead.lead_score || 0}`,
    '',
    ...signals.map(s => `• ${s}`),
    '',
    `Abrir lead: https://www.infinitylegacy.io/os/#inbox`,
  ];
  const message = lines.join('\n');

  try {
    await fetch(`https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: NOTIFY_NUMBER,
        type: 'text',
        text: { body: message },
      }),
    });
    await getSupabase().from('system_state').upsert({
      key: lastKey, value: { last_notified_at: new Date().toISOString(), signals },
    });
  } catch (e) {}
}

// ─────────────────────────────────────────────────────────
// Schedule follow-ups
// ─────────────────────────────────────────────────────────
async function scheduleFollowUps(leadId) {
  const now = Date.now();
  const schedule = [
    { type: '10min', delay: 10 * 60 * 1000 },
    { type: '30min', delay: 30 * 60 * 1000 },
    { type: '1day', delay: 24 * 3600 * 1000 },
    { type: '3day', delay: 3 * 24 * 3600 * 1000 },
    { type: '7day', delay: 7 * 24 * 3600 * 1000 },
  ];
  const inserts = schedule.map(s => ({
    lead_id: leadId,
    scheduled_for: new Date(now + s.delay).toISOString(),
    followup_type: s.type, status: 'pending',
  }));
  await getSupabase().from('follow_ups').insert(inserts);
}
