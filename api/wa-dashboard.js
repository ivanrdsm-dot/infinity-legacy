/*
 * Infinity Legacy — Dashboard API del Chatbot
 *
 * Devuelve estado de TODAS las conversaciones para que Iván vea en vivo:
 *   - Leads activos
 *   - Mensajes de cada uno
 *   - Escalaciones pendientes
 *   - Stats (leads totales, contratos cerrados, CPL si hay data)
 *
 * Endpoints (en query param ?action=):
 *   GET ?action=list                     → lista de leads con último mensaje
 *   GET ?action=conversation&lead_id=X   → historial completo de un lead
 *   GET ?action=stats                    → stats globales
 *   POST ?action=takeover&lead_id=X      → Iván toma control (pausa bot)
 *   POST ?action=release&lead_id=X       → Suelta control (bot reactivado)
 *   POST ?action=send&lead_id=X          → Iván envía mensaje manual (body: { text })
 *   POST ?action=note&lead_id=X          → Agrega nota interna (body: { text })
 *   POST ?action=close&lead_id=X         → Marca WON o LOST (body: { outcome })
 *
 * Auth: token via ?t= (mismo dashboard token actual)
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

// Lazy-init para evitar fallos en cold start (Node 20 + WS)
let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase env vars missing');
  }
  _supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false }, realtime: { transport: ws } }
  );
  return _supabase;
}
// alias para minimizar cambios en el resto del archivo
const supabase = new Proxy({}, {
  get: (_, prop) => getSupabase()[prop],
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Auth simple via token
  const token = (req.query.t || req.headers['x-dash-token'] || '').trim();
  if (!process.env.DASHBOARD_TOKEN) {
    return res.status(500).json({ error: 'DASHBOARD_TOKEN missing' });
  }
  if (token !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = req.query.action;
  const lead_id = req.query.lead_id;

  try {
    // ─── GET: list de conversaciones ───
    if (req.method === 'GET' && action === 'list') {
      // Intenta la vista lead_dashboard primero, fallback a tabla leads directo
      let r = await supabase
        .from('lead_dashboard')
        .select('*')
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .limit(200);
      if (r.error) {
        // Vista no existe → query a leads + último mensaje
        const leadsRes = await supabase
          .from('leads')
          .select('id, wa_phone, wa_name, stage, source, campaign, lead_score, matched_plan, bot_paused, last_message_at, message_count, created_at, priority, channel, ig_user_id')
          .order('last_message_at', { ascending: false, nullsFirst: false })
          .limit(200);
        // Pull last message body per lead
        const ids = (leadsRes.data || []).map(l => l.id);
        const { data: lastMsgs } = ids.length
          ? await supabase.from('messages').select('lead_id, body, direction, created_at').in('lead_id', ids).order('created_at', { ascending: false })
          : { data: [] };
        const seen = new Set();
        const lastByLead = {};
        for (const m of (lastMsgs || [])) {
          if (seen.has(m.lead_id)) continue;
          seen.add(m.lead_id);
          lastByLead[m.lead_id] = m;
        }
        const merged = (leadsRes.data || []).map(l => ({
          ...l,
          last_message_body: lastByLead[l.id]?.body || null,
          last_message_direction: lastByLead[l.id]?.direction || null,
        }));
        return res.status(200).json({ ok: true, leads: merged, source: 'fallback' });
      }
      return res.status(200).json({ ok: true, leads: r.data || [], source: 'view' });
    }

    // ─── GET: historial de una conversación ───
    if (req.method === 'GET' && action === 'conversation' && lead_id) {
      const [leadRes, msgsRes, notesRes, escRes] = await Promise.all([
        supabase.from('leads').select('*').eq('id', lead_id).single(),
        supabase.from('messages').select('*').eq('lead_id', lead_id).order('created_at', { ascending: true }),
        supabase.from('notes').select('*').eq('lead_id', lead_id).order('created_at', { ascending: false }),
        supabase.from('escalations').select('*').eq('lead_id', lead_id).order('notified_at', { ascending: false }),
      ]);
      return res.status(200).json({
        ok: true,
        lead: leadRes.data,
        messages: msgsRes.data || [],
        notes: notesRes.data || [],
        escalations: escRes.data || [],
      });
    }

    // ─── GET: stats globales ───
    if (req.method === 'GET' && action === 'stats') {
      const [{ count: totalLeads }, { count: activeLeads }, { count: scheduledLeads }, { count: wonLeads }, { count: pendingEsc }] = await Promise.all([
        supabase.from('leads').select('*', { count: 'exact', head: true }),
        supabase.from('leads').select('*', { count: 'exact', head: true }).neq('stage', 'WON').neq('stage', 'LOST'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('stage', 'SCHEDULED'),
        supabase.from('leads').select('*', { count: 'exact', head: true }).eq('stage', 'WON'),
        supabase.from('escalations').select('*', { count: 'exact', head: true }).is('acknowledged_at', null),
      ]);
      // Stats by plan
      const { data: byPlan } = await supabase.from('leads').select('matched_plan').not('matched_plan', 'is', null);
      const planCounts = (byPlan || []).reduce((acc, l) => {
        acc[l.matched_plan] = (acc[l.matched_plan] || 0) + 1;
        return acc;
      }, {});
      return res.status(200).json({
        ok: true,
        totalLeads, activeLeads, scheduledLeads, wonLeads, pendingEsc,
        planCounts,
      });
    }

    // ─── POST: takeover (pausar bot) ───
    if (req.method === 'POST' && action === 'takeover' && lead_id) {
      await supabase.from('leads').update({
        bot_paused: true,
        paused_at: new Date().toISOString(),
        paused_by: 'ivan',
      }).eq('id', lead_id);
      // Cancelar todos los follow-ups pendientes
      await supabase.from('follow_ups')
        .update({ status: 'cancelled', cancelled_reason: 'bot_paused_takeover', cancelled_at: new Date().toISOString() })
        .eq('lead_id', lead_id)
        .eq('status', 'pending');
      return res.status(200).json({ ok: true, paused: true });
    }

    // ─── POST: release (reactivar bot) ───
    if (req.method === 'POST' && action === 'release' && lead_id) {
      await supabase.from('leads').update({
        bot_paused: false,
        paused_at: null,
      }).eq('id', lead_id);
      return res.status(200).json({ ok: true, paused: false });
    }

    // ─── POST: envío manual (Iván escribe) ───
    if (req.method === 'POST' && action === 'send' && lead_id) {
      const { text } = req.body || {};
      if (!text) return res.status(400).json({ error: 'text required' });

      const { data: lead } = await supabase.from('leads').select('wa_phone').eq('id', lead_id).single();

      // Enviar vía Meta WA Cloud API (solo si está configurado, si no lo simula)
      if (process.env.WA_ACCESS_TOKEN && process.env.WA_PHONE_NUMBER_ID) {
        await fetch(`https://graph.facebook.com/v21.0/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: lead.wa_phone,
            type: 'text',
            text: { body: text, preview_url: true },
          }),
        });
      }

      // Persistir el mensaje
      await supabase.from('messages').insert({
        lead_id,
        direction: 'outbound',
        sender_type: 'ivan',
        body: text,
      });
      await supabase.from('leads').update({
        last_outbound_at: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
      }).eq('id', lead_id);

      return res.status(200).json({ ok: true, sent: true });
    }

    // ─── POST: nota interna ───
    if (req.method === 'POST' && action === 'note' && lead_id) {
      const { text, tag } = req.body || {};
      if (!text) return res.status(400).json({ error: 'text required' });
      await supabase.from('notes').insert({
        lead_id, author: 'ivan', body: text, tag,
      });
      return res.status(200).json({ ok: true });
    }

    // ─── POST: cerrar como WON / LOST ───
    if (req.method === 'POST' && action === 'close' && lead_id) {
      const { outcome } = req.body || {};
      if (!['WON', 'LOST'].includes(outcome)) return res.status(400).json({ error: 'outcome must be WON or LOST' });
      await supabase.from('leads').update({ stage: outcome }).eq('id', lead_id);
      await supabase.from('follow_ups')
        .update({ status: 'cancelled', cancelled_reason: 'lead_' + outcome.toLowerCase() })
        .eq('lead_id', lead_id)
        .eq('status', 'pending');
      return res.status(200).json({ ok: true, stage: outcome });
    }

    // ─── POST: WIPE — limpia TODO (leads, messages, follow_ups, notes, escalations) ───
    // Requiere body: { confirm: "WIPE_ALL" } para evitar accidentes.
    if (req.method === 'POST' && action === 'wipe') {
      const { confirm } = req.body || {};
      if (confirm !== 'WIPE_ALL') {
        return res.status(400).json({ error: 'Confirmation required: body must include { "confirm": "WIPE_ALL" }' });
      }
      const counts = {};
      // Orden: tablas dependientes primero (FK), luego leads
      for (const table of ['messages', 'follow_ups', 'notes', 'escalations']) {
        const r = await supabase.from(table).delete().neq('id', '00000000-0000-0000-0000-000000000000');
        counts[table] = r.error ? { error: r.error.message } : (r.count ?? 'ok');
      }
      const r = await supabase.from('leads').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      counts.leads = r.error ? { error: r.error.message } : (r.count ?? 'ok');
      return res.status(200).json({ ok: true, wiped: counts });
    }

    // ─── GET: cost summary (Claude API gasto + breakdown) ───
    if (req.method === 'GET' && action === 'cost') {
      // últimas 24h, agrupado por día / por lead
      const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
      const [today, week, byLead] = await Promise.all([
        supabase.from('messages').select('llm_cost_usd').gte('created_at', since24h).not('llm_cost_usd', 'is', null),
        supabase.from('messages').select('llm_cost_usd').gte('created_at', since7d).not('llm_cost_usd', 'is', null),
        supabase.from('messages').select('lead_id, llm_cost_usd').gte('created_at', since24h).not('llm_cost_usd', 'is', null),
      ]);
      const sum = (rows) => (rows || []).reduce((acc, r) => acc + parseFloat(r.llm_cost_usd || 0), 0);
      const cost24h = sum(today.data);
      const cost7d = sum(week.data);
      // Top spenders (leads que consumen más)
      const byLeadMap = {};
      (byLead.data || []).forEach(r => {
        byLeadMap[r.lead_id] = (byLeadMap[r.lead_id] || 0) + parseFloat(r.llm_cost_usd || 0);
      });
      const topSpenders = Object.entries(byLeadMap).sort((a,b) => b[1] - a[1]).slice(0, 10);
      // # de mensajes outbound bot (proxy de calls)
      const { count: callsToday } = await supabase
        .from('messages').select('*', { count: 'exact', head: true })
        .eq('sender_type', 'bot').gte('created_at', since24h);
      return res.status(200).json({
        ok: true,
        cost_24h_usd: cost24h,
        cost_7d_usd: cost7d,
        calls_today: callsToday,
        avg_cost_per_call: callsToday ? cost24h / callsToday : 0,
        top_spenders: topSpenders.map(([lead_id, cost]) => ({ lead_id, cost_usd: cost })),
        projected_monthly_usd: cost7d * (30/7),
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('[Dashboard]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
