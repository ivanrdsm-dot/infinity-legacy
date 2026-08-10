/*
 * Hub de herramientas internas — consolida 6 endpoints en 1 función serverless
 * (límite del plan Hobby de Vercel: 12 funciones por deployment).
 * Las URLs públicas no cambian: vercel.json reescribe /api/<tool> → /api/tools?fn=<tool>.
 */
import adPrecheck from '../lib/tools/ad-precheck.js';
import compose from '../lib/tools/compose.js';
import dashboard from '../lib/tools/dashboard.js';
import waDashboard from '../lib/tools/wa-dashboard.js';
import waRegisterRetry from '../lib/tools/wa-register-retry.js';
import waMetaVerifyCheck from '../lib/tools/wa-meta-verify-check.js';

const HANDLERS = {
  'ad-precheck': adPrecheck,
  'compose': compose,
  'dashboard': dashboard,
  'wa-dashboard': waDashboard,
  'wa-register-retry': waRegisterRetry,
  'wa-meta-verify-check': waMetaVerifyCheck,
};

export default async function handler(req, res) {
  const fromUrl = (req.url.match(/\/api\/([a-z0-9-]+)/i) || [])[1];
  const fn = (req.query && req.query.fn) || (fromUrl !== 'tools' ? fromUrl : null);
  const h = HANDLERS[fn];
  if (!h) return res.status(404).json({ error: 'unknown tool', fn: fn || null });
  return h(req, res);
}
