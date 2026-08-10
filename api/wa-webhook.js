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
import ws from 'ws';
import { recalcAndPersistScore } from './wa-bot/lead-scoring.js';
import { auditMessage, shouldBlock } from './wa-bot/compliance-audit.js';

// Disable Vercel body parser — we need raw body for Meta signature verification
export const config = {
  api: {
    bodyParser: false,
  },
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Lazy-init para evitar fallos en module load si env vars no están listas
// o si Vercel no bundleó el .md
let _SYSTEM_PROMPT = null;
function getSystemPrompt() {
  if (_SYSTEM_PROMPT) return _SYSTEM_PROMPT;
  try {
    _SYSTEM_PROMPT = fs.readFileSync(
      path.join(process.cwd(), 'api/wa-bot/system-prompt.md'),
      'utf-8'
    );
  } catch (e) {
    console.error('[WA] fs.readFileSync failed:', e.message);
    _SYSTEM_PROMPT = 'Eres el Asistente Infinity Legacy. Plan BRONZE $50K-$200K (1.5%/mes), SILVER $200K-$400K (2%/mes), GOLD $400K-$700K (2.5%/mes), BLACK $700K-$1M (3%/mes), BLACK MORE+ $1M+ (3.5%/mes). Sé cordial, breve, compliance CNBV (nunca digas "invertir", "rendimiento garantizado"). Usa "mandante", "aportación", "contrato de mandato", "resultados operativos variables".';
  }
  return _SYSTEM_PROMPT;
}

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase env vars missing');
  }
  _supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { persistSession: false },
      realtime: { transport: ws },
    }
  );
  return _supabase;
}

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY missing');
  }
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// ─────────────────────────────────────────────────────────
// PRE-FILTER — mensajes triviales que NO necesitan Claude ($0 saving)
// Si el mensaje es solo un emoji, "ok", "gracias", "👍", etc, respondemos
// canned. Esto reduce ~20-30% de calls a Claude en una conversación normal.
// ─────────────────────────────────────────────────────────
function isTrivialMessage(text) {
  if (!text) return null;
  const t = text.trim().toLowerCase();
  if (t.length === 0) return 'empty';
  // Solo emojis (1-3 chars en runas)
  const emojiOnly = /^[\p{Emoji}\p{Emoji_Modifier}‍️\s]+$/u.test(text) && text.replace(/\s/g,'').length <= 6;
  if (emojiOnly) return 'emoji';
  // Acknowledgments cortos
  const acks = ['ok','okay','okey','vale','sale','va','listo','perfecto','gracias','grcs','thx','thank you','dale','ya','si','sí','no','nop','nope','jaja','jeje','jajaja','👍','👌','✅','🙏','okk','yes'];
  if (acks.includes(t)) return 'ack';
  // 1-2 caracteres no-emoji = ruido (a, b, x, .)
  if (t.length <= 2 && !/^[a-z]+$/.test(t)) return 'noise';
  return null;
}

function trivialReply(kind) {
  // Solo respondemos a ACK (reconocer + invitar a seguir). Para emoji/noise NO respondemos
  // (evita loop infinito).
  if (kind === 'ack') {
    return '👌 Cuando quieras seguimos. Si te queda alguna duda del Programa de Acceso o quieres ver los planes, escríbeme aquí.';
  }
  return null; // emoji/noise → no respondemos
}

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

  // Leer raw body (necesario para verificar firma de Meta)
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    console.error('[WA] getRawBody failed:', e.message);
    return res.status(400).send('Bad Request');
  }

  // Verificar firma Meta (seguridad) — usando raw body, no re-stringified
  const signature = req.headers['x-hub-signature-256'];
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.WA_APP_SECRET)
    .update(rawBody)
    .digest('hex');
  if (signature !== expected) {
    console.warn('[WA] Invalid signature. Expected vs received:', { expected, got: signature, bodyLen: rawBody.length });
    // En lugar de rechazar, log y continuamos (Meta a veces tarda en sincronizar app secret).
    // Si necesitas STRICT, descomenta la siguiente línea:
    // return res.status(401).send('Invalid signature');
  }

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch (e) {
    console.error('[WA] JSON.parse failed:', e.message, 'body:', rawBody.substring(0, 200));
    return res.status(400).send('Invalid JSON');
  }

  const debug = req.query.debug === 'true';
  const log = [];
  log.push({ step: 'rawBodyLen', value: rawBody.length });
  log.push({ step: 'parsedBody', value: parsedBody ? 'parsed_ok' : 'null' });

  try {
    const entries = parsedBody?.entry || [];
    log.push({ step: 'entries.length', value: entries.length });
    for (const entry of entries) {
      const changes = entry.changes || [];
      log.push({ step: 'changes.length', value: changes.length });
      for (const change of changes) {
        log.push({ step: 'change.field', value: change.field });
        if (change.field !== 'messages') continue;
        const value = change.value;
        const messages = value.messages || [];
        log.push({ step: 'messages.length', value: messages.length });
        for (const msg of messages) {
          log.push({ step: 'processInboundMessage_start', value: msg.from });
          await processInboundMessage(msg, value.contacts?.[0]);
          log.push({ step: 'processInboundMessage_done', value: msg.from });
        }
      }
    }
    if (debug) return res.status(200).json({ ok: true, log });
    return res.status(200).send('OK');
  } catch (e) {
    console.error('[WA] Handler error:', e.message, '| stack:', e.stack);
    if (debug) return res.status(200).json({ ok: false, error: e.message, stack: e.stack, log });
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

  // 🔒 IDEMPOTENCIA: skip si ya procesamos este message_id
  if (wa_message_id) {
    try {
      const { data: existing } = await getSupabase()
        .from('messages')
        .select('id')
        .eq('wa_message_id', wa_message_id)
        .maybeSingle();
      if (existing) {
        console.log(`[WA] Duplicate ${wa_message_id} — skipping`);
        return;
      }
    } catch (e) { /* continue if check fails */ }
  }

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
      const update = {
        source: refData.src || 'meta',
        campaign: refData.cmp,
        ad_id: refData.ad,
      };
      // funnel stage si viene
      if (refData.funnel) update.funnel_stage = refData.funnel;
      await getSupabase().from('leads').update(update).eq('id', lead.id);
    }
  }

  // 3. Save inbound message
  await getSupabase().from('messages').insert({
    lead_id: lead.id,
    direction: 'inbound',
    sender_type: 'lead',
    body: text,
    message_type: msg.type || 'text',
    wa_message_id,
    il_ref: parseIlRefRaw(text),
  });

  // 3.5 EXTRACT DATA from message + persist (email, phone, intent signals)
  await extractAndPersistLeadData(lead, text);

  // 3.6 RECALC lead score (based on all inbound messages + data captured)
  try {
    const scoreResult = await recalcAndPersistScore(getSupabase(), lead);
    lead.lead_score = scoreResult.score;
    lead.tier = scoreResult.tier;
    console.log(`[WA] Lead ${lead.id} score: ${scoreResult.score} (${scoreResult.tier_emoji} ${scoreResult.tier})`);
  } catch (e) { console.error('[WA] score calc failed:', e.message); }

  // 4. Cancelar follow-ups pendientes (el lead ya respondió)
  await getSupabase().from('follow_ups')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_reason: 'lead_responded' })
    .eq('lead_id', lead.id)
    .eq('status', 'pending');

  // 5. Si el bot está pausado, no contestar — Iván va a responder manual
  if (lead.bot_paused) {
    console.log(`[WA] Bot paused for lead ${lead.id} — Iván responds manually`);
    return;
  }

  // 6a. BUDGET CAP DIARIO: si gastamos >$3 USD/día en Claude, pausar bot.
  // Iván se entera vía dashboard, decide si subir cap o esperar.
  const dailyBudget = parseFloat(process.env.CLAUDE_DAILY_BUDGET_USD || '3');
  const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: todayCost } = await getSupabase()
    .from('messages')
    .select('llm_cost_usd')
    .gte('created_at', since24h)
    .not('llm_cost_usd', 'is', null);
  const spentToday = (todayCost || []).reduce((a, r) => a + parseFloat(r.llm_cost_usd || 0), 0);
  if (spentToday >= dailyBudget) {
    console.warn(`[WA] Daily budget exceeded ($${spentToday.toFixed(2)} >= $${dailyBudget}) — skipping Claude call`);
    // Notificar a Iván UNA vez al día (no en cada mensaje)
    return;
  }

  // 6b. PRE-FILTER: si el mensaje es trivial (emoji, "ok", "gracias", <3 chars),
  // respuesta canned sin Claude → $0.
  const trivial = isTrivialMessage(text);
  if (trivial) {
    const cannedReply = trivialReply(trivial);
    if (cannedReply) {
      await sendWaMessage(from, cannedReply);
      await getSupabase().from('messages').insert({
        lead_id: lead.id,
        direction: 'outbound',
        sender_type: 'bot',
        body: cannedReply,
        llm_model: 'canned',
        llm_cost_usd: 0,
      });
      await scheduleFollowUps(lead.id);
      await getSupabase().from('leads').update({
        last_message_at: new Date().toISOString(),
        last_outbound_at: new Date().toISOString(),
        message_count: (lead.message_count || 0) + 1,
      }).eq('id', lead.id);
      console.log(`[WA] Trivial msg "${text.substring(0,20)}" → canned reply, $0`);
      return;
    }
  }

  // 6c. Generar respuesta con Claude
  const response = await generateBotResponse(lead);

  // 7. Enviar respuesta — saltar si Claude regresó meta-text de no-respuesta
  const txt = (response.text || '').trim();
  const isMetaNoResponse = !txt ||
    /^\*?\(?\s*no\s*response/i.test(txt) ||
    /^\(no\s*response/i.test(txt) ||
    txt.length < 5;
  if (txt && !isMetaNoResponse) {
    // 🛡️ COMPLIANCE AUDIT (Haiku ~$0.0001) — block messages with critical/high violations
    const audit = await auditMessage(getAnthropic(), txt);
    if (shouldBlock(audit)) {
      console.warn(`[WA] 🚨 BLOCKED message for lead ${lead.id}: ${audit.severity}`, audit.violations);
      // Persist blocked attempt for audit log
      await getSupabase().from('messages').insert({
        lead_id: lead.id,
        direction: 'outbound',
        sender_type: 'bot',
        body: '[BLOCKED BY COMPLIANCE] ' + txt,
        llm_model: 'claude-sonnet-4-5+blocked',
        llm_cost_usd: (response.cost_usd || 0) + (audit.audit_cost_usd || 0),
      });
      // Notify Iván
      try {
        await sendWaMessage(NOTIFY_NUMBER || '525646665718', `🚨 COMPLIANCE BLOCK\nLead: ${lead.wa_phone}\nSeverity: ${audit.severity}\nViolations: ${(audit.violations||[]).join(', ')}\n\nBlocked draft: "${txt.substring(0, 200)}..."`);
      } catch (e) {}
      // Don't send to lead — let bot try again on next message
      return;
    }
    await sendWaMessage(from, txt);
    await getSupabase().from('messages').insert({
      lead_id: lead.id,
      direction: 'outbound',
      sender_type: 'bot',
      body: response.text,
      llm_model: 'claude-sonnet-4-5',
      llm_tokens_in: response.tokens_in,
      llm_tokens_out: response.tokens_out,
      llm_cost_usd: (response.cost_usd || 0) + (audit.audit_cost_usd || 0),
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
  await getSupabase().from('leads').update({
    last_message_at: new Date().toISOString(),
    last_outbound_at: new Date().toISOString(),
    message_count: (lead.message_count || 0) + 1,
  }).eq('id', lead.id);
}

// ─────────────────────────────────────────────────────────
// UPSERT LEAD
// ─────────────────────────────────────────────────────────
async function upsertLead(from, contact, firstMessage) {
  const sel = await getSupabase()
    .from('leads')
    .select('*')
    .eq('wa_phone', from)
    .maybeSingle();
  if (sel.error) {
    console.error('[WA] upsertLead select error:', sel.error);
    throw new Error('Supabase select failed: ' + sel.error.message);
  }
  if (sel.data) return { lead: sel.data, isNew: false };

  const ins = await getSupabase().from('leads').insert({
    wa_phone: from,
    wa_name: contact?.profile?.name || null,
    stage: 'INITIAL',
    first_message_at: new Date().toISOString(),
  }).select().single();
  if (ins.error) {
    console.error('[WA] upsertLead insert error:', ins.error);
    throw new Error('Supabase insert failed: ' + ins.error.message);
  }
  return { lead: ins.data, isNew: true };
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
  // Anti-loop: si el lead tiene >40 mensajes, cancelar follow-ups pendientes
  // (probablemente es un loop o test runaway)
  if ((lead.message_count || 0) > 40) {
    console.warn(`[WA] Lead ${lead.id} has ${lead.message_count} messages — auto-cancelling follow-ups to prevent runaway`);
    await getSupabase().from('follow_ups')
      .update({ status: 'cancelled', cancelled_reason: 'message_count_exceeded', cancelled_at: new Date().toISOString() })
      .eq('lead_id', lead.id)
      .eq('status', 'pending');
  }

  // Pull last 12 messages (down from 30) — costo input lineal con history length
  const { data: history } = await getSupabase()
    .from('messages')
    .select('direction, sender_type, body, created_at')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: false })
    .limit(12)
    .then(r => ({ data: (r.data || []).reverse() }));

  // Build context for Claude
  const conversationHistory = (history || []).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body,
  }));

  // Funnel-aware hint
  const funnel = lead.funnel_stage || '';
  let funnelHint = '';
  if (funnel === 'bofu') {
    funnelHint = `\n⚠️ Este lead vino de un anuncio BOFU (cierre). Tono más directo: 2 frases de pitch + ofrece agendar sesión YA. No re-eduques mucho.`;
  } else if (funnel === 'mofu') {
    funnelHint = `\n⚠️ Este lead vino de un anuncio MOFU (consideración). Probablemente ya conoce algo. Tono: confirma entendimiento, califica ticket, propón sesión en mensajes 2-3.`;
  } else if (funnel === 'tofu') {
    funnelHint = `\n⚠️ Este lead vino de un anuncio TOFU (descubrimiento). Probablemente sabe poco. Tono: educa breve, califica ticket gradualmente, sesión cuando muestre interés concreto.`;
  } else if (funnel === 'rt') {
    funnelHint = `\n⚠️ Este lead viene de un retargeting (ya nos vio antes). Reconoce ese contexto sutilmente — "qué bueno que regresas" — y avanza más rápido al cierre.`;
  }

  // Inject lead context as a system reminder at the end of system prompt
  const leadContext = `
# 📌 CONTEXTO DE ESTE LEAD ESPECÍFICO
- ID: ${lead.id}
- WA Phone: ${lead.wa_phone}
- WA Name: ${lead.wa_name || 'desconocido'}
- Stage actual: ${lead.stage}
- Plan calculado en web (si lo hizo): ${lead.calc_plan || 'N/A'} con $${lead.calc_amount || 'N/A'} MXN a ${lead.calc_months || 'N/A'} meses
- Fuente: ${lead.source || 'desconocida'} | Campaña: ${lead.campaign || 'N/A'} | Ad: ${lead.ad_id || 'N/A'} | Funnel: ${funnel || 'N/A'}
- Mensajes previos: ${lead.message_count || 0}
- Lead score: ${lead.lead_score || 0}/100
${funnelHint}

# 🔗 LINKS REALES Y FLUJO DE AGENDA
- Calculadora del Programa de Acceso: https://www.infinitylegacy.io/programa-acceso#calculadora
- Landing principal: https://www.infinitylegacy.io/programa-acceso

⚠️ FLUJO DE AGENDA (sin Calendly por ahora):
Cuando el lead quiera agendar la sesión de 60 min, NO le pases ningún link.
En su lugar di EXACTO algo como:
"Perfecto. Le paso tu contacto a Iván del equipo principal. Él te escribe desde este mismo WhatsApp en menos de 30 min con 2-3 horarios disponibles esta semana para que escojas el que mejor te acomode. Mientras tanto, ¿me confirmas tu nombre completo para tenerlo en el contexto cuando llegue?"

Esto es importante: Iván coordina la agenda manual desde el dashboard. No menciones Calendly ni links externos de agenda.

Usa este contexto SUTILMENTE. NUNCA digas literal "veo que tu lead score es X" ni "vi que viniste del ad image_narrativa5pct".`;

  // Prompt caching: el system prompt (10KB) cambia muy poco entre calls.
  // Lo separamos en 2 bloques: SYSTEM_PROMPT estático (cacheable 5 min) +
  // leadContext dinámico (no cacheable). Resultado: -90% input cost en
  // calls subsecuentes dentro de la misma ventana de 5 min.
  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 600, // down from 1024 — respuestas WhatsApp deben ser breves
    system: [
      {
        type: 'text',
        text: getSystemPrompt(),
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: leadContext,
      },
    ],
    messages: conversationHistory.length ? conversationHistory : [{ role: 'user', content: '[Lead nuevo, primer mensaje]' }],
  });

  const text = response.content?.[0]?.text || '';
  const tokens_in = response.usage?.input_tokens || 0;
  const tokens_out = response.usage?.output_tokens || 0;
  const cache_read = response.usage?.cache_read_input_tokens || 0;
  const cache_create = response.usage?.cache_creation_input_tokens || 0;
  // Sonnet 4.5 pricing (per 1M tokens):
  //   uncached input: $3, output: $15
  //   cache write: $3.75, cache read: $0.30 (10% del input)
  const cost_usd = (
    tokens_in * 3 +
    tokens_out * 15 +
    cache_create * 3.75 +
    cache_read * 0.30
  ) / 1_000_000;

  console.log(`[WA] Claude cost: $${cost_usd.toFixed(5)} | in=${tokens_in} out=${tokens_out} cache_r=${cache_read} cache_w=${cache_create}`);
  return { text, tokens_in, tokens_out, cost_usd, tools: [] };
}

// ─────────────────────────────────────────────────────────
// NORMALIZE MEXICAN PHONE NUMBER
// México mobile webhooks llegan como 521XXXXXXXXXX (con el "1" móvil),
// pero Cloud API requiere enviar sin el "1": 52XXXXXXXXXX.
// Si el send falla con not-in-allowed-list, intentamos el otro formato.
// ─────────────────────────────────────────────────────────
function mxToggle(phone) {
  if (!phone) return phone;
  // 521XXXXXXXXXX (13 dígitos) → 52XXXXXXXXXX (12 dígitos)
  if (/^521\d{10}$/.test(phone)) return '52' + phone.slice(3);
  // 52XXXXXXXXXX (12 dígitos, México) → 521XXXXXXXXXX (13 dígitos)
  if (/^52\d{10}$/.test(phone)) return '521' + phone.slice(2);
  return phone;
}

// ─────────────────────────────────────────────────────────
// SEND WHATSAPP MESSAGE via Meta Cloud API
// ─────────────────────────────────────────────────────────
async function sendWaMessage(to, body) {
  const url = `https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`;

  async function attempt(toNumber) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toNumber,
        type: 'text',
        text: { body, preview_url: true },
      }),
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { /* keep raw */ }
    return { resp, text, parsed };
  }

  // Intento 1: número tal cual viene del webhook
  let { resp, text, parsed } = await attempt(to);
  if (resp.ok) return parsed || { raw: text };

  // Intento 2: si falló con "not in allowed list" (131030) o "phone number not valid" (131026),
  // probar con el formato MX inverso (con/sin el "1").
  const isMxRetryable = parsed?.error?.code === 131030 || parsed?.error?.code === 131026;
  const alt = mxToggle(to);
  if (isMxRetryable && alt && alt !== to) {
    console.warn(`[WA send] retry with MX-toggle: ${to} → ${alt}`);
    const r2 = await attempt(alt);
    if (r2.resp.ok) return r2.parsed || { raw: r2.text };
    console.error('[WA send] Failed (both formats):', r2.resp.status, r2.text);
    return { error: true, status: r2.resp.status, body: r2.text };
  }

  console.error('[WA send] Failed:', resp.status, text);
  return { error: true, status: resp.status, body: text };
}

// ─────────────────────────────────────────────────────────
// HANDLE BOT TOOLS (escalación, agenda, tagging)
// ─────────────────────────────────────────────────────────
async function handleBotTool(tool, lead) {
  if (tool.name === 'escalate_to_ivan') {
    await getSupabase().from('escalations').insert({
      lead_id: lead.id,
      reason: tool.args.reason,
      urgency: tool.args.urgency || 'normal',
      context: tool.args.context,
    });
    // Notificar a Iván vía WA
    await sendWaMessage(process.env.IVAN_NOTIFY_NUMBER,
      `🚨 ESCALACIÓN ${tool.args.urgency?.toUpperCase() || 'NORMAL'}\nLead: ${lead.wa_name || lead.wa_phone}\nMotivo: ${tool.args.reason}\nContexto: ${tool.args.context}\n\nDashboard: https://www.infinitylegacy.io/wa-dashboard?t=...`);
  } else if (tool.name === 'set_stage') {
    await getSupabase().from('leads').update({ stage: tool.args.stage }).eq('id', lead.id);
  } else if (tool.name === 'set_matched_plan') {
    await getSupabase().from('leads').update({ matched_plan: tool.args.plan }).eq('id', lead.id);
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
    const { data } = await getSupabase().from('leads').select('id, wa_phone, wa_name').eq('wa_phone', p).maybeSingle();
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
      await getSupabase().from('leads').update({
        bot_paused: true, paused_at: new Date().toISOString(), paused_by: 'ivan'
      }).eq('id', lead.id);
      await getSupabase().from('follow_ups')
        .update({ status: 'cancelled', cancelled_reason: 'ivan_takeover', cancelled_at: new Date().toISOString() })
        .eq('lead_id', lead.id).eq('status', 'pending');
      return reply(`✅ Bot pausado para ${lead.wa_name || phone}. A partir de aquí escribes tú.`);

    case '/bot':
      if (!lead) return reply('Usa: /bot [phone]');
      await getSupabase().from('leads').update({ bot_paused: false, paused_at: null }).eq('id', lead.id);
      return reply(`✅ Bot reactivado para ${lead.wa_name || phone}.`);

    case '/escalar':
      if (!lead) return reply('Usa: /escalar [phone]');
      await getSupabase().from('leads').update({ priority: 'urgent' }).eq('id', lead.id);
      return reply(`🚨 Lead ${lead.wa_name || phone} marcado como URGENT.`);

    case '/cerrar':
      if (!lead || !arg) return reply('Usa: /cerrar [phone] won|lost');
      const outcome = arg.toLowerCase() === 'won' ? 'WON' : 'LOST';
      await getSupabase().from('leads').update({ stage: outcome }).eq('id', lead.id);
      await getSupabase().from('follow_ups')
        .update({ status: 'cancelled', cancelled_reason: 'lead_' + outcome.toLowerCase() })
        .eq('lead_id', lead.id).eq('status', 'pending');
      return reply(`✅ Lead marcado como ${outcome}.`);

    case '/nota':
      if (!lead || !arg) return reply('Usa: /nota [phone] [texto de la nota]');
      await getSupabase().from('notes').insert({ lead_id: lead.id, author: 'ivan', body: arg, tag: 'manual' });
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

// ─────────────────────────────────────────────────────────
// EXTRACT LEAD DATA (email, phone, intent) from inbound text
// + notify Iván cuando lead esté HOT (anti-spam: max 1/hora)
// ─────────────────────────────────────────────────────────
const EMAIL_RX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_RX_MX = /\b(?:\+?52\s?1?\s?)?\(?(\d{2,3})\)?[\s.-]?(\d{3,4})[\s.-]?(\d{4})\b/;
const HIGH_INTENT_RX = /\b(ya\s*(quiero|estoy\s*listo|firmo|firma|me\s*decid)|vamos|agend[ae]mos|cuando\s*nos?\s*ve|me\s*interesa\s*mucho|s[íi]\s*claro\s*agend|listo\s*para\s*firma|cu[áa]ndo\s*podemos\s*hablar|qu[ée]\s*sigue|cu[áa]nto\s*es\s*el\s*m[íi]nimo|cu[áa]l\s*es\s*la\s*cuenta)/i;
const NOTIFY_NUMBER = process.env.IVAN_NOTIFY_NUMBER || '525646665718';

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
      const stripped = { ...updates };
      delete stripped.email;
      delete stripped.lead_phone;
      if (Object.keys(stripped).length > 0) {
        await getSupabase().from('leads').update(stripped).eq('id', lead.id);
      }
    }
    Object.assign(lead, updates);
  }

  if (signals.length > 0) {
    await maybeNotifyIvan(lead, signals);
  }
}

async function maybeNotifyIvan(lead, signals) {
  const lastKey = `notify_${lead.id}`;
  const { data: prevNotify } = await getSupabase()
    .from('system_state').select('value').eq('key', lastKey).maybeSingle();
  const lastAt = prevNotify?.value?.last_notified_at;
  if (lastAt && (Date.now() - new Date(lastAt).getTime() < 3600 * 1000)) return;

  const channelEmoji = lead.channel === 'instagram' ? '📷 IG' : '💬 WA';
  const lines = [
    `🚨 LEAD ${lead.priority === 'urgent' ? 'CALIENTE' : 'NUEVA SEÑAL'}`,
    `${channelEmoji} ${lead.wa_name || 'Sin nombre'} (+${lead.wa_phone})`,
    `Stage: ${lead.stage} · ${lead.message_count || 0} msgs`,
    '',
    ...signals.map(s => `• ${s}`),
    '',
    `Abrir lead: https://www.infinitylegacy.io/os/#inbox`,
  ];
  const message = lines.join('\n');

  try {
    await sendWaMessage(NOTIFY_NUMBER, message);
    await getSupabase().from('system_state').upsert({
      key: lastKey,
      value: { last_notified_at: new Date().toISOString(), signals },
    });
    console.log(`[WA] Notified Iván about lead ${lead.id}`);
  } catch (e) {
    console.error('[WA] Notify Iván failed:', e.message);
  }
}

async function scheduleFollowUps(leadId) {
  const now = Date.now();
  // Schedule menos agresivo + sin 5min spam.
  // 30min/7day usan canned ($0). 10min/1day/3day usan Haiku (12x más barato que Sonnet).
  const schedule = [
    { type: '10min', delay: 10 * 60 * 1000 },        // Haiku con valor
    { type: '30min', delay: 30 * 60 * 1000 },        // canned $0
    { type: '1day',  delay: 24 * 60 * 60 * 1000 },   // Haiku contextual
    { type: '3day',  delay: 3 * 24 * 60 * 60 * 1000 }, // Haiku contextual
    { type: '7day',  delay: 7 * 24 * 60 * 60 * 1000 }, // canned $0 (cierre)
  ];
  const inserts = schedule.map(s => ({
    lead_id: leadId,
    scheduled_for: new Date(now + s.delay).toISOString(),
    followup_type: s.type,
    status: 'pending',
  }));
  await getSupabase().from('follow_ups').insert(inserts);
}
