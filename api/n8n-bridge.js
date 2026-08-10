/*
 * Infinity Legacy — n8n Bridge endpoint
 *
 * Endpoint que recibe mensajes desde n8n (workflow con Evolution API/Baileys
 * que opera el 5566253065 vía WhatsApp Web protocol). Procesa con Claude
 * usando exactamente el mismo bot logic que wa-webhook.js, guarda en
 * Supabase con channel='whatsapp_web', y devuelve respuesta a n8n para
 * que la envíe vía Evolution API.
 *
 * Flow:
 *   n8n recibe DM → POST /api/n8n-bridge {from, text, message_id, name?}
 *   ↓
 *   Vercel: lógica Claude + persistencia
 *   ↓
 *   Vercel devuelve: { ok, response_text, should_send }
 *   ↓
 *   n8n envía vía Evolution API
 *
 * Auth: header X-N8N-Token o ?t= con N8N_BRIDGE_TOKEN (env var dedicada).
 *
 * Env vars necesarias:
 *   - N8N_BRIDGE_TOKEN (random secret compartido con n8n workflow)
 *   - ANTHROPIC_API_KEY (ya existe)
 *   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (ya existe)
 *   - CLAUDE_DAILY_BUDGET_USD (ya existe, default $3)
 */

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import ws from 'ws';

let _SYSTEM_PROMPT = null;
function getSystemPrompt() {
  if (_SYSTEM_PROMPT) return _SYSTEM_PROMPT;
  try {
    _SYSTEM_PROMPT = fs.readFileSync(path.join(process.cwd(), 'api/wa-bot/system-prompt.md'), 'utf-8');
  } catch (e) {
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-N8N-Token');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth: token compartido entre n8n y Vercel
  const provided = (req.headers['x-n8n-token'] || req.query.t || '').trim();
  const expected = process.env.N8N_BRIDGE_TOKEN;
  if (!expected) return res.status(500).json({ error: 'N8N_BRIDGE_TOKEN not configured' });
  if (provided !== expected) return res.status(401).json({ error: 'Unauthorized' });

  // Parse body
  let body = {};
  try {
    if (typeof req.body === 'object' && req.body !== null) body = req.body;
    else if (typeof req.body === 'string') body = JSON.parse(req.body);
  } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }

  const { from, text, message_id, name, channel = 'whatsapp_web' } = body;
  if (!from || !text) return res.status(400).json({ error: 'from and text required' });

  console.log(`[n8n-bridge] in: ${from} → "${text.substring(0, 60)}"`);

  try {
    // 1. Upsert lead
    const { lead, isNew } = await upsertLead(from, name, text, channel);

    // 2. Save inbound
    await insertMessageRobust({
      lead_id: lead.id,
      direction: 'inbound',
      sender_type: 'lead',
      body: text,
      message_type: 'text',
      wa_message_id: message_id,
      channel,
    });

    // 3. Cancel pending follow-ups
    await getSupabase().from('follow_ups')
      .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_reason: 'lead_responded' })
      .eq('lead_id', lead.id).eq('status', 'pending');

    // 4. Bot paused?
    if (lead.bot_paused) {
      return res.status(200).json({ ok: true, should_send: false, reason: 'bot_paused' });
    }

    // 5. Budget cap diario
    const dailyBudget = parseFloat(process.env.CLAUDE_DAILY_BUDGET_USD || '3');
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: todayCost } = await getSupabase()
      .from('messages').select('llm_cost_usd').gte('created_at', since24h).not('llm_cost_usd', 'is', null);
    const spentToday = (todayCost || []).reduce((a, r) => a + parseFloat(r.llm_cost_usd || 0), 0);
    if (spentToday >= dailyBudget) {
      console.warn(`[n8n-bridge] budget exceeded ($${spentToday.toFixed(2)})`);
      return res.status(200).json({ ok: true, should_send: false, reason: 'daily_budget_exceeded' });
    }

    // 6. Pre-filter triviales (canned, $0)
    const trivial = isTrivialMessage(text);
    if (trivial === 'ack') {
      const cannedReply = '👌 Cuando quieras seguimos. Si te queda alguna duda del Programa de Acceso, escríbeme aquí.';
      await insertMessageRobust({
        lead_id: lead.id, direction: 'outbound', sender_type: 'bot',
        body: cannedReply, llm_model: 'canned', llm_cost_usd: 0, channel,
      });
      await scheduleFollowUps(lead.id);
      await getSupabase().from('leads').update({
        last_message_at: new Date().toISOString(),
        last_outbound_at: new Date().toISOString(),
        message_count: (lead.message_count || 0) + 1,
      }).eq('id', lead.id);
      return res.status(200).json({ ok: true, should_send: true, response_text: cannedReply, source: 'canned' });
    }
    if (trivial === 'emoji' || trivial === 'noise') {
      // No respondemos a noise/emoji
      return res.status(200).json({ ok: true, should_send: false, reason: 'trivial_no_response' });
    }

    // 7. Generate response con Claude
    const response = await generateBotResponse(lead);
    const txt = (response.text || '').trim();
    if (!txt || txt.length < 5) {
      return res.status(200).json({ ok: true, should_send: false, reason: 'empty_response' });
    }

    // 8. Persist outbound
    await insertMessageRobust({
      lead_id: lead.id,
      direction: 'outbound',
      sender_type: 'bot',
      body: txt,
      llm_model: 'claude-sonnet-4-5',
      llm_tokens_in: response.tokens_in,
      llm_tokens_out: response.tokens_out,
      llm_cost_usd: response.cost_usd,
      channel,
    });

    // 9. Schedule follow-ups
    await scheduleFollowUps(lead.id);

    // 10. Update lead state
    await getSupabase().from('leads').update({
      last_message_at: new Date().toISOString(),
      last_outbound_at: new Date().toISOString(),
      message_count: (lead.message_count || 0) + 1,
    }).eq('id', lead.id);

    return res.status(200).json({
      ok: true,
      should_send: true,
      response_text: txt,
      source: 'claude',
      cost_usd: response.cost_usd,
      lead_id: lead.id,
    });
  } catch (e) {
    console.error('[n8n-bridge] error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
}

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
async function insertMessageRobust(payload) {
  let r = await getSupabase().from('messages').insert(payload);
  if (r.error && (r.error.code === '42703' || /column .* does not exist/i.test(r.error.message))) {
    const stripped = { ...payload };
    delete stripped.channel;
    r = await getSupabase().from('messages').insert(stripped);
  }
  if (r.error) console.error('[n8n-bridge] insert msg failed:', r.error.message);
}

async function upsertLead(from, name, firstMessage, channel) {
  let sel = await getSupabase().from('leads').select('*').eq('wa_phone', from).maybeSingle();
  if (sel.data) return { lead: sel.data, isNew: false };

  const payload = {
    wa_phone: from,
    wa_name: name || null,
    stage: 'INITIAL',
    source: channel === 'whatsapp_web' ? 'whatsapp_web' : channel,
    first_message_at: new Date().toISOString(),
  };
  let ins = await getSupabase().from('leads').insert({ ...payload, channel }).select().single();
  if (ins.error && (ins.error.code === '42703' || /column .* does not exist/i.test(ins.error.message))) {
    ins = await getSupabase().from('leads').insert(payload).select().single();
  }
  if (ins.error) throw new Error('upsert lead failed: ' + ins.error.message);
  return { lead: ins.data, isNew: true };
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
    .from('messages')
    .select('direction, body, created_at')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(12)
    .then(r => ({ data: (r.data || []).reverse() }));

  const conversationHistory = (history || []).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: (m.body || '').substring(0, 600),
  }));

  const leadContext = `
# 📌 CONTEXTO LEAD
- ID: ${lead.id}
- Phone: ${lead.wa_phone}
- Name: ${lead.wa_name || 'desconocido'}
- Stage: ${lead.stage}
- Source: ${lead.source || 'whatsapp_web'}
- Mensajes previos: ${lead.message_count || 0}
- Plan calculado (si lo hizo): ${lead.calc_plan || 'N/A'} con $${lead.calc_amount || 'N/A'} MXN
- Canal: WhatsApp (vía WhatsApp Web)

⚠️ FLUJO DE AGENDA: cuando lead quiera agendar, di "Le paso tu contacto a Iván del equipo. Te escribe desde este mismo WhatsApp con horarios en <30 min."

🔗 Calculadora: https://www.infinitylegacy.io/programa-acceso#calculadora`;

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600,
    system: [
      { type: 'text', text: getSystemPrompt(), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: leadContext },
    ],
    messages: conversationHistory.length ? conversationHistory : [{ role: 'user', content: '[Lead nuevo, primer mensaje]' }],
  });

  const text = response.content?.[0]?.text || '';
  const u = response.usage || {};
  const cost_usd = (
    (u.input_tokens || 0) * 3 + (u.output_tokens || 0) * 15 +
    (u.cache_creation_input_tokens || 0) * 3.75 + (u.cache_read_input_tokens || 0) * 0.30
  ) / 1_000_000;
  console.log(`[n8n-bridge] Claude cost: $${cost_usd.toFixed(5)}`);
  return { text, tokens_in: u.input_tokens || 0, tokens_out: u.output_tokens || 0, cost_usd };
}

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
