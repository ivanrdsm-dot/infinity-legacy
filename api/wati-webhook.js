/*
 * Infinity Legacy — Wati Webhook + Majo Bot
 *
 * Recibe eventos de Wati (BSP de WhatsApp) y los procesa con el mismo
 * bot Majo (Claude). Envía respuestas vía Wati Send Message API.
 *
 * Wati event format (típicamente):
 * {
 *   eventType: "message",
 *   eventDescription: "received",
 *   id: "...",
 *   whatsappMessageId: "wamid.XXX",
 *   conversationId: "...",
 *   ticketId: "...",
 *   text: "...",
 *   type: "text" | "image" | "audio" | "video" | "document",
 *   data: "...",  // for media
 *   timestamp: "...",
 *   owner: false,  // false = lead, true = our bot/agent
 *   waId: "5215566778899",  // sender's WhatsApp ID
 *   senderName: "Lead Name",
 *   listReply, buttonReply, ...
 * }
 *
 * Env vars:
 *   - WATI_API_TOKEN     (Bearer token from Wati)
 *   - WATI_API_BASE_URL  (https://live-server-XXXX.wati.io)
 *   - ANTHROPIC_API_KEY (existente)
 *   - SUPABASE_URL + SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import ws from 'ws';
import { recalcAndPersistScore } from '../lib/wa-bot/lead-scoring.js';
import { auditMessage, shouldBlock } from '../lib/wa-bot/compliance-audit.js';

export const config = { api: { bodyParser: true } };

let _SYSTEM_PROMPT = null;
function getSystemPrompt() {
  if (_SYSTEM_PROMPT) return _SYSTEM_PROMPT;
  try {
    _SYSTEM_PROMPT = fs.readFileSync(path.join(process.cwd(), 'api/wa-bot/system-prompt.md'), 'utf-8');
  } catch (e) {
    _SYSTEM_PROMPT = 'Eres Majo, asistente del equipo Infinity Legacy.';
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

const NOTIFY_NUMBER = '525646665718';

// ─────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Wati a veces hace GET para verificación inicial
  if (req.method === 'GET') return res.status(200).send('Wati webhook ready');
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body || {};

  // Save raw for debugging
  try {
    await getSupabase().from('system_state').upsert({
      key: 'last_wati_webhook',
      value: { body, received_at: new Date().toISOString() },
    });
  } catch (e) {}

  const eventType = body.eventType || body.event_type;
  const ownerOrAgent = body.owner === true || body.owner === 'true';

  // Solo procesamos mensajes ENTRANTES nuevos (del lead, no nuestros)
  if (eventType !== 'message' && eventType !== 'messageReceived' && !body.text && !body.data) {
    return res.status(200).json({ ok: true, skip: 'not_a_message' });
  }
  if (ownerOrAgent) {
    return res.status(200).json({ ok: true, skip: 'message_from_us' });
  }

  const waId = body.waId || body.from || body.phoneNumber;
  const senderName = body.senderName || body.name || null;
  const messageText = body.text || body.body || '';
  const messageType = body.type || 'text';
  const messageId = body.whatsappMessageId || body.id;

  if (!waId) return res.status(200).json({ ok: true, skip: 'no_sender' });

  console.log(`[Wati] in: ${waId} (${senderName||'?'}) "${(messageText||'').substring(0, 60)}"`);

  // Idempotency check
  if (messageId) {
    try {
      const { data: existing } = await getSupabase()
        .from('messages').select('id').eq('wa_message_id', messageId).maybeSingle();
      if (existing) { console.log(`[Wati] dup ${messageId} — skip`); return res.status(200).json({ ok: true, skip: 'duplicate' }); }
    } catch (e) {}
  }

  try {
    // 1. Upsert lead
    const { lead } = await upsertWatiLead(waId, senderName);

    // For non-text messages: canned reply, skip Claude
    if (messageType !== 'text' || !messageText) {
      const typeES = { image: 'imagen', audio: 'audio', video: 'video', document: 'documento', sticker: 'sticker' }[messageType] || 'archivo';
      const cannedReply = `Recibí tu ${typeES} 🙂 De este lado solo puedo conversar por texto. Cuéntame con palabras qué te interesa del Programa de Acceso y te ayudo con todo el detalle.`;
      await sendWatiMessage(waId, cannedReply);
      await insertMessageRobust({
        lead_id: lead.id, direction: 'inbound', sender_type: 'lead',
        body: `[${typeES}]`, message_type: messageType,
        wa_message_id: messageId, channel: 'whatsapp',
      });
      await insertMessageRobust({
        lead_id: lead.id, direction: 'outbound', sender_type: 'bot',
        body: cannedReply, llm_model: 'canned', llm_cost_usd: 0,
        channel: 'whatsapp',
      });
      return res.status(200).json({ ok: true, sent: 'canned_for_non_text' });
    }

    // 2. Save inbound
    await insertMessageRobust({
      lead_id: lead.id, direction: 'inbound', sender_type: 'lead',
      body: messageText, message_type: 'text',
      wa_message_id: messageId, channel: 'whatsapp',
    });

    // 3. Extract data + score
    await extractAndPersistLeadData(lead, messageText);
    try {
      const scoreResult = await recalcAndPersistScore(getSupabase(), lead);
      lead.lead_score = scoreResult.score;
      console.log(`[Wati] Lead ${lead.id} score: ${scoreResult.score} (${scoreResult.tier_emoji})`);
    } catch (e) {}

    // 4. Cancel follow-ups + check bot paused
    await getSupabase().from('follow_ups')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_reason: 'lead_responded' })
      .eq('lead_id', lead.id).eq('status', 'pending');
    if (lead.bot_paused) return res.status(200).json({ ok: true, skip: 'bot_paused' });

    // 5. Budget cap
    const dailyBudget = parseFloat(process.env.CLAUDE_DAILY_BUDGET_USD || '3');
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: todayCost } = await getSupabase()
      .from('messages').select('llm_cost_usd').gte('created_at', since24h).not('llm_cost_usd', 'is', null);
    const spentToday = (todayCost || []).reduce((a, r) => a + parseFloat(r.llm_cost_usd || 0), 0);
    if (spentToday >= dailyBudget) return res.status(200).json({ ok: true, skip: 'budget' });

    // 6. Generate Claude response
    const response = await generateBotResponse(lead);
    const txt = (response.text || '').trim();
    if (!txt || txt.length < 5) return res.status(200).json({ ok: true, skip: 'empty' });

    // 6.5 Compliance audit
    const audit = await auditMessage(getAnthropic(), txt);
    if (shouldBlock(audit)) {
      await insertMessageRobust({
        lead_id: lead.id, direction: 'outbound', sender_type: 'bot',
        body: '[BLOCKED BY COMPLIANCE] ' + txt,
        llm_model: 'claude-sonnet-4-5+blocked',
        llm_cost_usd: (response.cost_usd || 0) + (audit.audit_cost_usd || 0),
        channel: 'whatsapp',
      });
      return res.status(200).json({ ok: true, blocked: audit.severity });
    }

    // 7. Send via Wati
    await sendWatiMessage(waId, txt);

    // 8. Persist outbound
    await insertMessageRobust({
      lead_id: lead.id, direction: 'outbound', sender_type: 'bot',
      body: txt, llm_model: 'claude-sonnet-4-5',
      llm_tokens_in: response.tokens_in, llm_tokens_out: response.tokens_out,
      llm_cost_usd: (response.cost_usd || 0) + (audit.audit_cost_usd || 0),
      channel: 'whatsapp',
    });

    // 9. Schedule follow-ups + update lead
    await scheduleFollowUps(lead.id);
    await getSupabase().from('leads').update({
      last_message_at: new Date().toISOString(),
      last_outbound_at: new Date().toISOString(),
      message_count: (lead.message_count || 0) + 1,
    }).eq('id', lead.id);

    return res.status(200).json({ ok: true, sent: 'claude', cost: response.cost_usd });
  } catch (e) {
    console.error('[Wati] Handler error:', e.message, e.stack);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────
// SEND via Wati API
// ─────────────────────────────────────────────────────────
async function sendWatiMessage(waId, text) {
  const base = process.env.WATI_API_BASE_URL;
  const token = process.env.WATI_API_TOKEN;
  if (!base || !token) {
    console.error('[Wati send] missing WATI_API_BASE_URL or WATI_API_TOKEN');
    return;
  }
  const url = `${base.replace(/\/$/, '')}/api/v1/sendSessionMessage/${encodeURIComponent(waId)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `messageText=${encodeURIComponent(text)}`,
  });
  const respText = await resp.text();
  if (!resp.ok) {
    console.error('[Wati send] failed:', resp.status, respText.substring(0, 300));
    return { error: true, body: respText };
  }
  console.log('[Wati send] OK →', waId);
  try { return JSON.parse(respText); } catch (e) { return { raw: respText }; }
}

// ─────────────────────────────────────────────────────────
// HELPERS (compartidos con otros webhooks)
// ─────────────────────────────────────────────────────────
async function insertMessageRobust(payload) {
  let r = await getSupabase().from('messages').insert(payload);
  if (r.error && (/column .* does not exist/i.test(r.error.message) || /could not find the .* column/i.test(r.error.message))) {
    const stripped = { ...payload }; delete stripped.channel;
    r = await getSupabase().from('messages').insert(stripped);
  }
  if (r.error) console.error('[Wati] insert msg failed:', r.error.message);
}

async function upsertWatiLead(waId, name) {
  // waId comes from Wati like "5215566778899" — same as Cloud API format
  let sel = await getSupabase().from('leads').select('*').eq('wa_phone', waId).maybeSingle();
  if (sel.data) return { lead: sel.data, isNew: false };

  const payload = {
    wa_phone: waId, wa_name: name,
    stage: 'INITIAL', source: 'wati',
    first_message_at: new Date().toISOString(),
  };
  let ins = await getSupabase().from('leads').insert({ ...payload, channel: 'whatsapp' }).select().single();
  if (ins.error && (/column .* does not exist/i.test(ins.error.message) || /could not find the .* column/i.test(ins.error.message))) {
    ins = await getSupabase().from('leads').insert(payload).select().single();
  }
  if (ins.error) throw new Error('Wati upsert lead failed: ' + ins.error.message);
  return { lead: ins.data, isNew: true };
}

async function generateBotResponse(lead) {
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
- ID: ${lead.id} · Phone: ${lead.wa_phone} · Name: ${lead.wa_name || 'desconocido'}
- Stage: ${lead.stage} · Mensajes previos: ${lead.message_count || 0}
- Canal: WhatsApp (vía Wati)
- Score: ${lead.lead_score || 0}/100

⚠️ Cuando lead pida agendar: "Le paso tu contacto a Iván del equipo. Te escribe desde este mismo WhatsApp con horarios en <30 min."`;

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: [
      { type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: leadContext },
    ],
    messages: conversationHistory.length ? conversationHistory : [{ role: 'user', content: '[Lead nuevo en WhatsApp]' }],
  });

  const text = response.content?.[0]?.text || '';
  const u = response.usage || {};
  const cost_usd = (
    (u.input_tokens || 0) * 3 + (u.output_tokens || 0) * 15 +
    (u.cache_creation_input_tokens || 0) * 3.75 + (u.cache_read_input_tokens || 0) * 0.30
  ) / 1_000_000;
  return { text, tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0, cost_usd };
}

const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RX_MX = /\b(?:\+?52\s?1?\s?)?\(?(\d{2,3})\)?[\s.-]?(\d{3,4})[\s.-]?(\d{4})\b/;
const HIGH_INTENT_RX = /\b(ya\s*(quiero|estoy\s*listo|firmo|firma|me\s*decid)|vamos|agend[ae]mos|cuando\s*nos?\s*ve|me\s*interesa\s*mucho|s[íi]\s*claro\s*agend|listo\s*para\s*firma|cu[áa]ndo\s*podemos\s*hablar|qu[ée]\s*sigue|cu[áa]nto\s*es\s*el\s*m[íi]nimo)/i;

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
      if (fullPhone !== lead.wa_phone && !lead.lead_phone) {
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
    `🚨 LEAD ${lead.priority === 'urgent' ? 'CALIENTE' : 'NUEVA SEÑAL'} (WhatsApp/Wati)`,
    `💬 ${lead.wa_name || 'Sin nombre'} (+${lead.wa_phone})`,
    `Stage: ${lead.stage} · ${lead.message_count || 0} msgs · Score ${lead.lead_score || 0}`,
    '', ...signals.map(s => `• ${s}`), '',
    `Abrir lead: https://www.infinitylegacy.io/os/#inbox`,
  ];
  const message = lines.join('\n');

  // Notify Iván via Wati (mismo canal — Iván recibe desde el bot)
  try {
    await sendWatiMessage(NOTIFY_NUMBER, message);
    await getSupabase().from('system_state').upsert({
      key: lastKey, value: { last_notified_at: new Date().toISOString(), signals },
    });
  } catch (e) {}
}

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
