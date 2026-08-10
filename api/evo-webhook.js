/*
 * Infinity Legacy — Evolution API Webhook (WhatsApp Web vía Baileys)
 *
 * Recibe eventos de Evolution API hosteada en Railway. Procesa con Claude
 * (misma lógica que wa-webhook y n8n-bridge), guarda en Supabase con
 * channel='whatsapp_web', y envía respuesta de vuelta vía Evolution API.
 *
 * Evolution event format (messages.upsert):
 * {
 *   event: "messages.upsert",
 *   instance: "infinity-legacy",
 *   data: {
 *     key: { remoteJid: "521...@s.whatsapp.net", fromMe: false, id: "..." },
 *     pushName: "Cliente Name",
 *     message: { conversation: "Hola..." } | { extendedTextMessage: { text: "..." } },
 *     messageType: "conversation" | "extendedTextMessage",
 *     messageTimestamp: 1234567890
 *   }
 * }
 *
 * Env vars:
 *   - EVOLUTION_API_URL (https://evolution-api-production-7415c.up.railway.app)
 *   - EVOLUTION_API_KEY (auth header)
 *   - EVOLUTION_INSTANCE_NAME (default: infinity-legacy)
 *   - ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (ya existen)
 */

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import ws from 'ws';

export const config = { api: { bodyParser: true } };

let _SYSTEM_PROMPT = null;
function getSystemPrompt() {
  if (_SYSTEM_PROMPT) return _SYSTEM_PROMPT;
  try {
    _SYSTEM_PROMPT = fs.readFileSync(path.join(process.cwd(), 'api/wa-bot/system-prompt.md'), 'utf-8');
  } catch (e) { _SYSTEM_PROMPT = 'Eres el Asistente Infinity Legacy.'; }
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
  if (req.method !== 'POST') return res.status(200).send('OK');

  const body = req.body || {};
  const event = body.event || '';
  const data = body.data || {};

  // Solo procesamos mensajes entrantes nuevos
  if (event !== 'messages.upsert' && event !== 'MESSAGES_UPSERT' && event !== 'messages-upsert') {
    return res.status(200).json({ ok: true, ignored: event });
  }

  // Skip mensajes propios (fromMe=true) y de grupos
  const key = data.key || {};
  if (key.fromMe) return res.status(200).json({ ok: true, skip: 'fromMe' });
  const remoteJid = key.remoteJid || '';
  if (remoteJid.endsWith('@g.us')) return res.status(200).json({ ok: true, skip: 'group' });

  // Extraer texto (varios formatos posibles)
  const msg = data.message || {};
  const text = (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.buttonsResponseMessage?.selectedDisplayText ||
    msg.listResponseMessage?.title ||
    ''
  ).trim();

  if (!text) {
    console.log('[evo-webhook] no text, skipping:', Object.keys(msg));
    return res.status(200).json({ ok: true, skip: 'no_text' });
  }

  // Parse phone from JID: "5215566253065@s.whatsapp.net" → "5215566253065"
  const phone = remoteJid.split('@')[0];
  const pushName = data.pushName || null;
  const messageId = key.id;

  console.log(`[evo-webhook] ${phone} (${pushName||'?'}): "${text.substring(0,60)}"`);

  try {
    // 1. Upsert lead
    const { lead } = await upsertLead(phone, pushName);

    // 2. Save inbound
    await insertMessageRobust({
      lead_id: lead.id, direction: 'inbound', sender_type: 'lead',
      body: text, message_type: 'text', wa_message_id: messageId,
      channel: 'whatsapp_web',
    });

    // 3. Cancel pending follow-ups
    await getSupabase().from('follow_ups')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_reason: 'lead_responded' })
      .eq('lead_id', lead.id).eq('status', 'pending');

    if (lead.bot_paused) return res.status(200).json({ ok: true, skip: 'bot_paused' });

    // 4. Budget cap
    const dailyBudget = parseFloat(process.env.CLAUDE_DAILY_BUDGET_USD || '3');
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: todayCost } = await getSupabase()
      .from('messages').select('llm_cost_usd').gte('created_at', since24h).not('llm_cost_usd', 'is', null);
    const spentToday = (todayCost || []).reduce((a, r) => a + parseFloat(r.llm_cost_usd || 0), 0);
    if (spentToday >= dailyBudget) {
      console.warn(`[evo-webhook] budget exceeded $${spentToday.toFixed(2)}`);
      return res.status(200).json({ ok: true, skip: 'budget' });
    }

    // 5. Pre-filter triviales
    const trivial = isTrivialMessage(text);
    if (trivial === 'ack') {
      const cannedReply = '👌 Cuando quieras seguimos. Si te queda alguna duda del Programa de Acceso, escríbeme aquí.';
      await sendEvoMessage(phone, cannedReply);
      await insertMessageRobust({
        lead_id: lead.id, direction: 'outbound', sender_type: 'bot',
        body: cannedReply, llm_model: 'canned', llm_cost_usd: 0, channel: 'whatsapp_web',
      });
      await scheduleFollowUps(lead.id);
      await updateLeadCounters(lead);
      return res.status(200).json({ ok: true, sent: 'canned' });
    }
    if (trivial === 'emoji' || trivial === 'noise') return res.status(200).json({ ok: true, skip: 'trivial' });

    // 6. Generate Claude response
    const response = await generateBotResponse(lead);
    const txt = (response.text || '').trim();
    if (!txt || txt.length < 5) return res.status(200).json({ ok: true, skip: 'empty' });

    // 7. Send via Evolution API
    await sendEvoMessage(phone, txt);

    // 8. Persist outbound
    await insertMessageRobust({
      lead_id: lead.id, direction: 'outbound', sender_type: 'bot',
      body: txt, llm_model: 'claude-sonnet-4-5',
      llm_tokens_in: response.tokens_in, llm_tokens_out: response.tokens_out,
      llm_cost_usd: response.cost_usd, channel: 'whatsapp_web',
    });

    // 9. Schedule follow-ups
    await scheduleFollowUps(lead.id);

    // 10. Update lead counters
    await updateLeadCounters(lead);

    return res.status(200).json({ ok: true, sent: 'claude', cost: response.cost_usd });
  } catch (e) {
    console.error('[evo-webhook] error:', e.message, e.stack);
    return res.status(200).json({ ok: false, error: e.message });
  }
}

// ─────────────────────────────────────────────────────────
// SEND via Evolution API
// ─────────────────────────────────────────────────────────
async function sendEvoMessage(toPhone, text) {
  const baseUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;
  const instance = process.env.EVOLUTION_INSTANCE_NAME || 'infinity-legacy';
  if (!baseUrl || !apiKey) {
    console.error('[evo send] EVOLUTION_API_URL or EVOLUTION_API_KEY missing');
    return;
  }
  const url = `${baseUrl}/message/sendText/${instance}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': apiKey },
    body: JSON.stringify({
      number: toPhone,
      text,
    }),
  });
  const respText = await resp.text();
  if (!resp.ok) {
    console.error('[evo send] failed:', resp.status, respText);
    return { error: true };
  }
  console.log('[evo send] success →', toPhone);
  try { return JSON.parse(respText); } catch (e) { return { raw: respText }; }
}

// ─────────────────────────────────────────────────────────
// HELPERS (compartidos con n8n-bridge)
// ─────────────────────────────────────────────────────────
async function insertMessageRobust(payload) {
  let r = await getSupabase().from('messages').insert(payload);
  if (r.error && (r.error.code === '42703' || /column .* does not exist/i.test(r.error.message))) {
    const stripped = { ...payload }; delete stripped.channel;
    r = await getSupabase().from('messages').insert(stripped);
  }
  if (r.error) console.error('[evo] insert msg failed:', r.error.message);
}

async function upsertLead(from, name) {
  let sel = await getSupabase().from('leads').select('*').eq('wa_phone', from).maybeSingle();
  if (sel.data) return { lead: sel.data, isNew: false };

  const payload = {
    wa_phone: from, wa_name: name, stage: 'INITIAL',
    source: 'whatsapp_web',
    first_message_at: new Date().toISOString(),
  };
  let ins = await getSupabase().from('leads').insert({ ...payload, channel: 'whatsapp_web' }).select().single();
  if (ins.error && (ins.error.code === '42703' || /column .* does not exist/i.test(ins.error.message))) {
    ins = await getSupabase().from('leads').insert(payload).select().single();
  }
  if (ins.error) throw new Error('upsert lead failed: ' + ins.error.message);
  return { lead: ins.data, isNew: true };
}

async function updateLeadCounters(lead) {
  await getSupabase().from('leads').update({
    last_message_at: new Date().toISOString(),
    last_outbound_at: new Date().toISOString(),
    message_count: (lead.message_count || 0) + 1,
  }).eq('id', lead.id);
}

function isTrivialMessage(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (t.length === 0) return 'empty';
  const emojiOnly = /^[\p{Emoji}\p{Emoji_Modifier}‍️\s]+$/u.test(text) && text.replace(/\s/g, '').length <= 6;
  if (emojiOnly) return 'emoji';
  const acks = ['ok','okay','okey','vale','sale','va','listo','perfecto','gracias','grcs','thx','dale','ya','si','sí','no','nop','nope','jaja','jeje','jajaja','👍','👌','✅','🙏','okk','yes'];
  if (acks.includes(t)) return 'ack';
  if (t.length <= 2 && !/^[a-z]+$/.test(t)) return 'noise';
  return null;
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
- Canal: WhatsApp (vía WhatsApp Web)

🔗 Calculadora: https://www.infinitylegacy.io/programa-acceso#calculadora

⚠️ Cuando lead pida agendar: "Le paso tu contacto a Iván del equipo. Te escribe desde este mismo WhatsApp con horarios en <30 min."`;

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: [
      { type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: leadContext },
    ],
    messages: conversationHistory.length ? conversationHistory : [{ role: 'user', content: '[Lead nuevo]' }],
  });

  const text = response.content?.[0]?.text || '';
  const u = response.usage || {};
  const cost_usd = (
    (u.input_tokens || 0) * 3 + (u.output_tokens || 0) * 15 +
    (u.cache_creation_input_tokens || 0) * 3.75 + (u.cache_read_input_tokens || 0) * 0.30
  ) / 1_000_000;
  console.log(`[evo-webhook] Claude cost: $${cost_usd.toFixed(5)}`);
  return { text, tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0, cost_usd };
}

async function scheduleFollowUps(leadId) {
  const now = Date.now();
  const schedule = [
    { type: '10min', delay: 10*60*1000 },
    { type: '30min', delay: 30*60*1000 },
    { type: '1day', delay: 24*3600*1000 },
    { type: '3day', delay: 3*24*3600*1000 },
    { type: '7day', delay: 7*24*3600*1000 },
  ];
  const inserts = schedule.map(s => ({
    lead_id: leadId,
    scheduled_for: new Date(now + s.delay).toISOString(),
    followup_type: s.type, status: 'pending',
  }));
  await getSupabase().from('follow_ups').insert(inserts);
}
