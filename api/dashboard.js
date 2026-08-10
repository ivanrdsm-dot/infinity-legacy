/*
 * Infinity Legacy — Dashboard API endpoint
 *
 * Pulls live metrics from Meta Marketing API and returns to the
 * frontend dashboard (/dashboard.html).
 *
 * Auth: simple shared-secret token validated against env DASHBOARD_TOKEN.
 *
 * Env vars required (Vercel):
 *   - META_MARKETING_TOKEN  (System User token from il-operator)
 *   - DASHBOARD_TOKEN       (random secret for browser auth)
 */

const AD_ACCOUNT = 'act_1865053780841329';
const PIXEL_ID = '847380765079387';

async function metaFetch(path, token) {
  const url = `https://graph.facebook.com/v21.0/${path}${path.includes('?') ? '&' : '?'}access_token=${token}`;
  const r = await fetch(url);
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(`Meta API ${r.status}: ${err.error?.message || r.statusText}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();

  // Auth
  const token = (req.query.t || req.headers['x-dash-token'] || '').trim();
  if (!process.env.DASHBOARD_TOKEN) {
    return res.status(500).json({ error: 'Server not configured (DASHBOARD_TOKEN missing)' });
  }
  if (token !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const META_TOKEN = process.env.META_MARKETING_TOKEN;
  if (!META_TOKEN) {
    return res.status(500).json({ error: 'META_MARKETING_TOKEN not configured' });
  }

  try {
    // Run all queries in parallel for speed
    const [account, todayInsights, last7dInsights, campaigns, ads] = await Promise.all([
      metaFetch(`${AD_ACCOUNT}?fields=name,currency,timezone_name,balance,amount_spent,spend_cap`, META_TOKEN),

      metaFetch(`${AD_ACCOUNT}/insights?fields=spend,impressions,clicks,ctr,cpm,cpc,reach,frequency,actions&date_preset=today`, META_TOKEN),

      metaFetch(`${AD_ACCOUNT}/insights?fields=spend,impressions,clicks,ctr,actions&date_preset=last_7d&time_increment=1`, META_TOKEN),

      metaFetch(`${AD_ACCOUNT}/campaigns?fields=name,status,objective,daily_budget,lifetime_budget,buying_type,start_time,stop_time&limit=20`, META_TOKEN),

      metaFetch(`${AD_ACCOUNT}/ads?fields=name,status,adset_id,campaign_id,creative{thumbnail_url,title,body}&limit=20`, META_TOKEN)
    ]);

    // Aggregate today metrics
    const today = (todayInsights.data || [])[0] || {};

    // Build daily timeline (last 7 days)
    const daily = (last7dInsights.data || []).map(d => ({
      date: d.date_start,
      spend: parseFloat(d.spend || 0),
      impressions: parseInt(d.impressions || 0),
      clicks: parseInt(d.clicks || 0),
      ctr: parseFloat(d.ctr || 0),
      leads: ((d.actions || []).find(a => a.action_type === 'lead') || { value: 0 }).value
    }));

    // Pixel real-time check
    const pixelEvents = await metaFetch(`${PIXEL_ID}/stats?fields=event,count&start_time=${Math.floor(Date.now()/1000) - 86400}&end_time=${Math.floor(Date.now()/1000)}`, META_TOKEN).catch(() => ({ data: [] }));

    return res.status(200).json({
      ok: true,
      timestamp: new Date().toISOString(),
      account: {
        name: account.name,
        currency: account.currency,
        timezone: account.timezone_name,
        balance: parseFloat(account.balance || 0) / 100,
        amount_spent: parseFloat(account.amount_spent || 0) / 100,
        spend_cap: parseFloat(account.spend_cap || 0) / 100
      },
      today: {
        spend: parseFloat(today.spend || 0),
        impressions: parseInt(today.impressions || 0),
        clicks: parseInt(today.clicks || 0),
        ctr: parseFloat(today.ctr || 0),
        cpm: parseFloat(today.cpm || 0),
        cpc: parseFloat(today.cpc || 0),
        reach: parseInt(today.reach || 0),
        frequency: parseFloat(today.frequency || 0),
        actions: today.actions || []
      },
      daily,
      campaigns: (campaigns.data || []).map(c => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective,
        daily_budget_mxn: c.daily_budget ? parseFloat(c.daily_budget) / 100 : null,
        lifetime_budget_mxn: c.lifetime_budget ? parseFloat(c.lifetime_budget) / 100 : null,
        start: c.start_time,
        stop: c.stop_time
      })),
      ads: (ads.data || []).map(a => ({
        id: a.id,
        name: a.name,
        status: a.status,
        adset_id: a.adset_id,
        campaign_id: a.campaign_id,
        thumbnail: a.creative?.thumbnail_url,
        title: a.creative?.title,
        body_preview: (a.creative?.body || '').substring(0, 140)
      })),
      pixel: {
        id: PIXEL_ID,
        events_24h: pixelEvents.data || []
      }
    });
  } catch (e) {
    console.error('[Dashboard API]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
