/*
 * Infinity Legacy — Chatbot Simulator
 *
 * Permite probar el bot SIN tener WhatsApp Cloud API conectado.
 * Útil para validar el system prompt, el funnel y los follow-ups
 * antes de conectar el webhook real a Meta.
 *
 * Uso vía curl:
 *   curl -X POST https://www.infinitylegacy.io/api/wa-simulate \
 *     -H "Content-Type: application/json" \
 *     -H "x-sim-token: <SIMULATOR_TOKEN>" \
 *     -d '{"phone": "525555555555", "message": "Hola, quiero conocer el programa"}'
 *
 * Devuelve:
 *   {
 *     "lead_id": "uuid",
 *     "stage": "INITIAL",
 *     "bot_response": "¡Hola! Gracias por escribir...",
 *     "tokens": { in: 1500, out: 200 },
 *     "cost_usd": 0.0075,
 *     "tools_called": []
 *   }
 *
 * Variables env:
 *   - ANTHROPIC_API_KEY
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - SIMULATOR_TOKEN  (random secret, solo tú lo conoces)
 */

import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(process.cwd(), 'api/wa-bot/system-prompt.md'),
  'utf-8'
);

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-sim-token');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Auth simulator (token simple, solo para testing)
  const token = req.headers['x-sim-token'];
  if (!process.env.SIMULATOR_TOKEN || token !== process.env.SIMULATOR_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { phone, message, sim_name = 'Test Lead' } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone and message required' });
  }

  try {
    // Upsert lead
    let { data: lead } = await supabase
      .from('leads')
      .select('*')
      .eq('wa_phone', phone)
      .maybeSingle();

    if (!lead) {
      const { data: newLead } = await supabase.from('leads').insert({
        wa_phone: phone,
        wa_name: sim_name,
        stage: 'INITIAL',
      }).select().single();
      lead = newLead;
    }

    // Parse il-ref si viene en el mensaje
    const refMatch = message.match(/\[il-ref:([^\]]+)\]/);
    if (refMatch && !lead.ad_id) {
      const inside = refMatch[1].trim();
      const obj = {};
      inside.split(/\s+/).forEach(p => {
        const [k, v] = p.split('=');
        if (k && v) obj[k] = v;
      });
      await supabase.from('leads').update({
        source: obj.src || 'simulator',
        campaign: obj.cmp,
        ad_id: obj.ad,
      }).eq('id', lead.id);
      Object.assign(lead, { source: obj.src, campaign: obj.cmp, ad_id: obj.ad });
    }

    // Save inbound message
    await supabase.from('messages').insert({
      lead_id: lead.id,
      direction: 'inbound',
      sender_type: 'lead',
      body: message,
      il_ref: refMatch ? refMatch[0] : null,
    });

    // Pull last 30 messages
    const { data: history } = await supabase
      .from('messages')
      .select('direction, body')
      .eq('lead_id', lead.id)
      .order('created_at', { ascending: true })
      .limit(30);

    const convoHistory = (history || []).slice(0, -1).map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body,
    }));
    convoHistory.push({ role: 'user', content: message });

    // Lead context for Claude
    const leadCtx = `
# 📌 CONTEXTO DEL LEAD (uso interno, NO repetir literal)
- Phone: ${lead.wa_phone}
- Nombre: ${lead.wa_name || 'desconocido'}
- Stage actual: ${lead.stage}
- Plan calculado en web: ${lead.calc_plan || 'no usó calculadora'}
- Fuente: ${lead.source || 'desconocida'} | Ad: ${lead.ad_id || 'N/A'}
- Mensajes previos: ${lead.message_count || 0}
- Lead score: ${lead.lead_score || 0}/100`;

    const start = Date.now();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT + '\n\n' + leadCtx,
      messages: convoHistory,
    });
    const ms = Date.now() - start;

    const text = response.content?.[0]?.text || '';
    const tin = response.usage?.input_tokens || 0;
    const tout = response.usage?.output_tokens || 0;
    const cost = (tin * 3 + tout * 15) / 1_000_000;

    // Save outbound message
    await supabase.from('messages').insert({
      lead_id: lead.id,
      direction: 'outbound',
      sender_type: 'bot',
      body: text,
      llm_model: 'claude-sonnet-4-5',
      llm_tokens_in: tin,
      llm_tokens_out: tout,
      llm_cost_usd: cost,
    });

    await supabase.from('leads').update({
      last_message_at: new Date().toISOString(),
      last_outbound_at: new Date().toISOString(),
      message_count: (lead.message_count || 0) + 2,
    }).eq('id', lead.id);

    return res.status(200).json({
      ok: true,
      lead_id: lead.id,
      stage: lead.stage,
      bot_response: text,
      tokens: { in: tin, out: tout },
      cost_usd: parseFloat(cost.toFixed(5)),
      latency_ms: ms,
      ad_id: lead.ad_id,
      hint: 'Para continuar la conversación, llama de nuevo con el mismo phone',
    });
  } catch (e) {
    console.error('[Sim] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
