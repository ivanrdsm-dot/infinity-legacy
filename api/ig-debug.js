/*
 * Debug endpoint: regresa el último webhook IG recibido
 * Auth: DASHBOARD_TOKEN
 */
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }, realtime: { transport: ws },
  });
  return _supabase;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const token = (req.query.t || '').trim();
  if (token !== process.env.DASHBOARD_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  // Return BOTH the raw last webhook AND the processing steps
  const [hookRes, procRes] = await Promise.all([
    getSupabase().from('system_state').select('value, updated_at').eq('key', 'last_ig_webhook').maybeSingle(),
    getSupabase().from('system_state').select('value, updated_at').eq('key', 'last_ig_processing').maybeSingle(),
  ]);

  return res.status(200).json({
    ok: true,
    last_webhook: hookRes.data || null,
    last_processing: procRes.data || null,
  });
}
