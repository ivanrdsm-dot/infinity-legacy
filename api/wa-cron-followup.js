/*
 * Infinity Legacy — Cron Job de Follow-ups
 *
 * Se ejecuta cada 1 min via Vercel Cron. Revisa la cola de follow_ups
 * pendientes, genera el mensaje contextual con Claude y lo envía.
 *
 * Configurar en vercel.json:
 *   "crons": [{ "path": "/api/wa-cron-followup", "schedule": "* * * * *" }]
 *
 * Vars env: las mismas que /api/wa-webhook.js
 */

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';

// Lazy-init para serverless
let _SYSTEM_PROMPT = null;
function getSystemPrompt() {
  if (_SYSTEM_PROMPT) return _SYSTEM_PROMPT;
  try {
    _SYSTEM_PROMPT = fs.readFileSync(path.join(process.cwd(), 'api/wa-bot/system-prompt.md'), 'utf-8');
  } catch (e) {
    console.error('[Cron] fs.readFileSync failed:', e.message);
    _SYSTEM_PROMPT = 'Eres el Asistente Infinity Legacy. Genera follow-ups breves y empáticos.';
  }
  return _SYSTEM_PROMPT;
}

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase env missing');
  _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return _supabase;
}

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

export default async function handler(req, res) {
  // Vercel cron auth header
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).end('Unauthorized');
  }

  try {
    // Pull follow-ups pendientes que ya vencieron
    const { data: dueFollowups } = await getSupabase()
      .from('follow_ups')
      .select('*, leads(*)')
      .eq('status', 'pending')
      .lte('scheduled_for', new Date().toISOString())
      .limit(20);

    if (!dueFollowups?.length) {
      return res.status(200).json({ ok: true, processed: 0 });
    }

    let processed = 0;
    for (const fu of dueFollowups) {
      // Si el lead está pausado (humano lo tomó), saltarlo
      if (fu.leads?.bot_paused) {
        await getSupabase().from('follow_ups')
          .update({ status: 'cancelled', cancelled_reason: 'bot_paused' })
          .eq('id', fu.id);
        continue;
      }

      // Si el lead respondió DESPUÉS de programar este follow-up, saltarlo
      if (fu.leads?.last_message_at && new Date(fu.leads.last_message_at) > new Date(fu.created_at)) {
        await getSupabase().from('follow_ups')
          .update({ status: 'cancelled', cancelled_reason: 'lead_responded' })
          .eq('id', fu.id);
        continue;
      }

      // Generar y enviar follow-up
      const followupMsg = await generateFollowup(fu.leads, fu.followup_type);
      if (followupMsg) {
        await sendWaMessage(fu.leads.wa_phone, followupMsg);
        await getSupabase().from('messages').insert({
          lead_id: fu.lead_id,
          direction: 'outbound',
          sender_type: 'bot',
          body: followupMsg,
          llm_model: 'claude-sonnet-4-5',
        });
        await getSupabase().from('follow_ups')
          .update({ status: 'sent', sent_at: new Date().toISOString() })
          .eq('id', fu.id);
        await getSupabase().from('leads')
          .update({ last_outbound_at: new Date().toISOString() })
          .eq('id', fu.lead_id);
        processed++;
      }
    }

    return res.status(200).json({ ok: true, processed });
  } catch (e) {
    console.error('[Cron] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function generateFollowup(lead, type) {
  const { data: history } = await getSupabase()
    .from('messages')
    .select('direction, body')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: true })
    .limit(20);

  const prompt = `Esta conversación está en stage "${lead.stage}" y el lead no contestó. Genera un follow-up de tipo "${type}" siguiendo las reglas del system prompt. Responde SOLO el texto del mensaje (sin preámbulo ni comillas).`;
  const messages = (history || []).map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body,
  }));
  messages.push({ role: 'user', content: prompt });

  const response = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    system: getSystemPrompt(),
    messages,
  });
  return response.content?.[0]?.text?.trim();
}

async function sendWaMessage(to, body) {
  await fetch(`https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body },
    }),
  });
}
