/*
 * Infinity Legacy — WhatsApp Webhook + AI Bot Orchestrator
 *
 * Vercel serverless function que:
 *   1. Recibe mensajes entrantes de WhatsApp Cloud API
 *   2. Verifica firma de Meta para seguridad
 *   3. Persiste mensajes en Supabase
 *   4. Detecta si bot está pausado (humano tomó control)
 *   5. Si bot activo → genera respuesta con Claude Sonnet 4.5
 *   6. Envía respuesta vía WhatsApp Cloud API
 *   7. Agenda follow-ups automáticos
 *   8. Detecta triggers de escalación
 *
 * Variables de entorno requeridas en Vercel:
 *   - WA_VERIFY_TOKEN          (random secret, set en Meta webhook config)
 *   - WA_APP_SECRET            (Meta App Secret, para verificar firma)
 *   - WA_ACCESS_TOKEN          (System User token con permisos WhatsApp)
 *   - WA_PHONE_NUMBER_ID       (ID del número WhatsApp Business)
 *   - ANTHROPIC_API_KEY        (Claude API key)
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - IVAN_NOTIFY_NUMBER       (Iván's personal WA para escalations, ej. 525611357074)
 *   - CALENDLY_LINK            (link de booking 60min)
 *
 * Documentación Meta:
 *   https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/
 */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(process.cwd(), 'api/wa-bot/system-prompt.md'),
  'utf-8'
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // GET = Meta verifica el webhook al crear la integración
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

  // Verificar firma Meta (seguridad)
  const signature = req.headers['x-hub-signature-256'];
  const rawBody = JSON.stringify(req.body);
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.WA_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  if (signature !== expected) {
    console.warn('[WA] Invalid signature');
    return res.status(401).send('Invalid signature');
  }

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        const messages = value.messages || [];
        for (const msg of messages) {
          await processInboundMessage(msg, value.contacts?.[0]);
        }
      }
    }
    return res.status(200).send('OK');
  } catch (e) {
    console.error('[WA] Handler error:', e.message);
    // Devolvemos 200 igualmente para que Meta no reintente y duplique
    return res.status(200).send('OK');
  }
}

// ─────────────────────────────────────────────────────────
// PROCESS INBOUND MESSAGE
// ─────────────────────────────────────────────────────────
async function processInboundMessage(msg, contact) {
  const from = msg.from;
  const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || '[non-text]';
  const wa_message_id = msg.id;

  // ─── IVÁN COMMAND HANDLER ───
  // Si el mensaje viene del número personal de Iván Y empieza con "/",
  // lo trato como comando administrativo (NO se lo envío a un lead).
  const isIvan = from === process.env.IVAN_NOTIFY_NUMBER;
  if (isIvan && text.trim().startsWith('/')) {
    await handleIvanCommand(text);
    return;
  }

  // 1. Find or create lead
  const { lead, isNew } = await upsertLead(from, contact, text);

  // 2. Parse [il-ref] if present in the message (initial messages from ads)
  if (isNew || lead.message_count === 0) {
    const refData = parseIlRef(text);
    if (refData) {
      await supabase.from('leads').update({
        source: refData.src || 'meta',
        campaign: refData.cmp,
        ad_id: refData.ad,
      }).eq('id', lead.id);
    }
  }

  // 3. Save inbound message
  await supabase.from('messages').insert({
    lead_id: lead.id,
    direction: 'inbound',
    sender_type: 'lead',
    body: text,
    message_type: msg.type || 'text',
    wa_message_id,
    il_ref: parseIlRefRaw(text),
  });

  // 4. Cancelar follow-ups pendientes (el lead ya respondió)
  await supabase.from('follow_ups')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_reason: 'lead_responded' })
    .eq('lead_id', lead.id)
    .eq('status', 'pending');

  // 5. Si el bot está pausado, no contestar — Iván va a responder manual
  if (lead.bot_paused) {
    console.log(`[WA] Bot paused for lead ${lead.id} — Iván responds manually`);
    return;
  }

  // 6. Generar respuesta con Claude
  const response = await generateBotResponse(lead);

  // 7. Enviar respuesta
  if (response.text) {
    await sendWaMessage(from, response.text);
    await supabase.from('messages').insert({
      lead_id: lead.id,
      direction: 'outbound',
      sender_type: 'bot',
      body: response.text,
      llm_model: 'claude-sonnet-4-5',
      llm_tokens_in: response.tokens_in,
      llm_tokens_out: response.tokens_out,
      llm_cost_usd: response.cost_usd,
    });
  }

  // 8. Procesar tool calls del bot (escalación, agenda, tagging, etc.)
  if (response.tools?.length) {
    for (const tool of response.tools) {
      await handleBotTool(tool, lead);
    }
  }

  // 9. Programar follow-ups automáticos
  await scheduleFollowUps(lead.id);

  // 10. Actualizar lead state
  await supabase.from('leads').update({
    last_message_at: new Date().toISOString(),
    last_outbound_at: new Date().toISOString(),
    message_count: (lead.message_count || 0) + 1,
  }).eq('id', lead.id);
}

// ─────────────────────────────────────────────────────────
// UPSERT LEAD
// ─────────────────────────────────────────────────────────
async function upsertLead(from, contact, firstMessage) {
  const { data: existing } = await supabase
    .from('leads')
    .select('*')
    .eq('wa_phone', from)
    .maybeSingle();

  if (existing) return { lead: existing, isNew: false };

  const { data: newLead } = await supabase.from('leads').insert({
    wa_phone: from,
    wa_name: contact?.profile?.name || null,
    stage: 'INITIAL',
    first_message_at: new Date().toISOString(),
  }).select().single();

  return { lead: newLead, isNew: true };
}

// ─────────────────────────────────────────────────────────
// PARSE [il-ref: src=X cmp=Y ad=Z]
// ─────────────────────────────────────────────────────────
function parseIlRefRaw(text) {
  const match = text.match(/\[il-ref:[^\]]+\]/);
  return match ? match[0] : null;
}

function parseIlRef(text) {
  const raw = parseIlRefRaw(text);
  if (!raw) return null;
  const inside = raw.replace('[il-ref:', '').replace(']', '').trim();
  const obj = {};
  inside.split(/\s+/).forEach(pair => {
    const [k, v] = pair.split('=');
    if (k && v) obj[k] = v;
  });
  return obj;
}

// ─────────────────────────────────────────────────────────
// GENERATE BOT RESPONSE WITH CLAUDE
// ─────────────────────────────────────────────────────────
async function generateBotResponse(lead) {
  // Pull last 30 messages for context
  const { data: history } = await supabase
    .from('messages')
    .select('direction, sender_type, body, created_at')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: true })
    .limit(30);

  // Build context for Claude
  const conversationHistory = (history || []).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body,
  }));

  // Inject lead context as a system reminder at the end of system prompt
  const leadContext = `
# 📌 CONTEXTO DE ESTE LEAD ESPECÍFICO
- ID: ${lead.id}
- WA Phone: ${lead.wa_phone}
- WA Name: ${lead.wa_name || 'desconocido'}
- Stage actual: ${lead.stage}
- Plan calculado en web (si lo hizo): ${lead.calc_plan || 'N/A'} con $${lead.calc_amount || 'N/A'} MXN a ${lead.calc_months || 'N/A'} meses
- Fuente: ${lead.source || 'desconocida'} | Campaña: ${lead.campaign || 'N/A'} | Ad: ${lead.ad_id || 'N/A'}
- Mensajes previos: ${lead.message_count || 0}
- Lead score: ${lead.lead_score || 0}/100

Usa este contexto SUTILMENTE. NUNCA digas literal "veo que tu lead score es X" ni "vi que viniste del ad image_narrativa5pct".`;

  const fullSystem = SYSTEM_PROMPT + '\n\n' + leadContext;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1024,
    system: fullSystem,
    messages: conversationHistory.length ? conversationHistory : [{ role: 'user', content: '[Lead nuevo, primer mensaje]' }],
  });

  const text = response.content?.[0]?.text || '';
  const tokens_in = response.usage?.input_tokens || 0;
  const tokens_out = response.usage?.output_tokens || 0;
  const cost_usd = (tokens_in * 3 + tokens_out * 15) / 1_000_000; // Sonnet 4.5 pricing

  return { text, tokens_in, tokens_out, cost_usd, tools: [] };
}

// ─────────────────────────────────────────────────────────
// SEND WHATSAPP MESSAGE via Meta Cloud API
// ─────────────────────────────────────────────────────────
async function sendWaMessage(to, body) {
  const url = `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body, preview_url: true },
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error('[WA send] Failed:', resp.status, err);
  }
  return resp.json();
}

// ─────────────────────────────────────────────────────────
// HANDLE BOT TOOLS (escalación, agenda, tagging)
// ─────────────────────────────────────────────────────────
async function handleBotTool(tool, lead) {
  if (tool.name === 'escalate_to_ivan') {
    await supabase.from('escalations').insert({
      lead_id: lead.id,
      reason: tool.args.reason,
      urgency: tool.args.urgency || 'normal',
      context: tool.args.context,
    });
    // Notificar a Iván vía WA
    await sendWaMessage(process.env.IVAN_NOTIFY_NUMBER,
      `🚨 ESCALACIÓN ${tool.args.urgency?.toUpperCase() || 'NORMAL'}\nLead: ${lead.wa_name || lead.wa_phone}\nMotivo: ${tool.args.reason}\nContexto: ${tool.args.context}\n\nDashboard: https://www.infinitylegacy.io/wa-dashboard?t=...`);
  } else if (tool.name === 'set_stage') {
    await supabase.from('leads').update({ stage: tool.args.stage }).eq('id', lead.id);
  } else if (tool.name === 'set_matched_plan') {
    await supabase.from('leads').update({ matched_plan: tool.args.plan }).eq('id', lead.id);
  }
}

// ─────────────────────────────────────────────────────────
// SCHEDULE FOLLOW-UPS (5min / 10min / 30min / 1d / 3d / 7d)
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
// IVÁN COMMAND HANDLER
// Comandos desde su WhatsApp personal para tomar control del bot
//   /yo [phone]         pausa bot para ese lead (Iván responde manual)
//   /bot [phone]        re-activa bot
//   /escalar [phone]    marca priority='urgent'
//   /cerrar [phone] won pasa a WON
//   /cerrar [phone] lost pasa a LOST
//   /nota [phone] [text] nota interna
// ─────────────────────────────────────────────────────────
async function handleIvanCommand(text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace(/:$/, ''); // soporta "/yo:"
  const phone = parts[1];
  const arg = parts.slice(2).join(' ');

  async function findLead(p) {
    const { data } = await supabase.from('leads').select('id, wa_phone, wa_name').eq('wa_phone', p).maybeSingle();
    return data;
  }

  async function reply(text) {
    if (process.env.IVAN_NOTIFY_NUMBER) {
      await sendWaMessage(process.env.IVAN_NOTIFY_NUMBER, text);
    }
  }

  const lead = phone ? await findLead(phone) : null;
  if (phone && !lead) {
    return reply(`❌ No encontré lead con phone ${phone}`);
  }

  switch (cmd) {
    case '/yo':
      if (!lead) return reply('Usa: /yo [phone]');
      await supabase.from('leads').update({
        bot_paused: true, paused_at: new Date().toISOString(), paused_by: 'ivan'
      }).eq('id', lead.id);
      await supabase.from('follow_ups')
        .update({ status: 'cancelled', cancelled_reason: 'ivan_takeover', cancelled_at: new Date().toISOString() })
        .eq('lead_id', lead.id).eq('status', 'pending');
      return reply(`✅ Bot pausado para ${lead.wa_name || phone}. A partir de aquí escribes tú.`);

    case '/bot':
      if (!lead) return reply('Usa: /bot [phone]');
      await supabase.from('leads').update({ bot_paused: false, paused_at: null }).eq('id', lead.id);
      return reply(`✅ Bot reactivado para ${lead.wa_name || phone}.`);

    case '/escalar':
      if (!lead) return reply('Usa: /escalar [phone]');
      await supabase.from('leads').update({ priority: 'urgent' }).eq('id', lead.id);
      return reply(`🚨 Lead ${lead.wa_name || phone} marcado como URGENT.`);

    case '/cerrar':
      if (!lead || !arg) return reply('Usa: /cerrar [phone] won|lost');
      const outcome = arg.toLowerCase() === 'won' ? 'WON' : 'LOST';
      await supabase.from('leads').update({ stage: outcome }).eq('id', lead.id);
      await supabase.from('follow_ups')
        .update({ status: 'cancelled', cancelled_reason: 'lead_' + outcome.toLowerCase() })
        .eq('lead_id', lead.id).eq('status', 'pending');
      return reply(`✅ Lead marcado como ${outcome}.`);

    case '/nota':
      if (!lead || !arg) return reply('Usa: /nota [phone] [texto de la nota]');
      await supabase.from('notes').insert({ lead_id: lead.id, author: 'ivan', body: arg, tag: 'manual' });
      return reply(`✅ Nota guardada para ${lead.wa_name || phone}.`);

    case '/help':
    case '/ayuda':
      return reply([
        '📋 Comandos disponibles:',
        '/yo [phone] — pausar bot, escribes tú',
        '/bot [phone] — reactivar bot',
        '/escalar [phone] — marcar urgente',
        '/cerrar [phone] won|lost — cerrar lead',
        '/nota [phone] [texto] — nota interna',
      ].join('\n'));

    default:
      return reply(`❌ Comando desconocido: ${cmd}. Escribe /ayuda para ver comandos.`);
  }
}

async function scheduleFollowUps(leadId) {
  const now = Date.now();
  const schedule = [
    { type: '5min',  delay: 5 * 60 * 1000 },
    { type: '10min', delay: 10 * 60 * 1000 },
    { type: '30min', delay: 30 * 60 * 1000 },
    { type: '1day',  delay: 24 * 60 * 60 * 1000 },
    { type: '3day',  delay: 3 * 24 * 60 * 60 * 1000 },
    { type: '7day',  delay: 7 * 24 * 60 * 60 * 1000 },
  ];
  const inserts = schedule.map(s => ({
    lead_id: leadId,
    scheduled_for: new Date(now + s.delay).toISOString(),
    followup_type: s.type,
    status: 'pending',
  }));
  await supabase.from('follow_ups').insert(inserts);
}
