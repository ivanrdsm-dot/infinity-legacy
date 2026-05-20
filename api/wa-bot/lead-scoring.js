/*
 * Infinity Legacy — Lead Scoring Algorithm
 *
 * Calcula un score 0-100 para cada lead basado en señales medibles:
 *   - 35% — Capital mencionado en mensajes ($ rango)
 *   - 20% — Palabras de alto intento (intent signals)
 *   - 15% — Engagement (# mensajes inbound)
 *   - 15% — Datos capturados (email/teléfono/nombre dados)
 *   - 10% — Source del lead (BOFU ads valen más)
 *   - 5% — Recency (lead activo en últimas 24h)
 *
 * Output: integer 0-100, donde:
 *   >= 80 → 🔥 HOT (llamar inmediato, top priority)
 *   60-79 → 🌟 WARM (push agendar sesión)
 *   40-59 → 👀 LUKEWARM (nurture)
 *   < 40 → COLD (educar más)
 */

// ─────────────────────────────────────────────────────────
// Capital signals — detect dollar amounts mentioned
// ─────────────────────────────────────────────────────────
const CAPITAL_PATTERNS = [
  // "$1M", "$500k", "1.5M", "500 mil", "1 millón"
  { rx: /\$?\s*(\d+(?:[.,]\d+)?)\s*m(?:il|illon|illón)?(?:es)?\b/i, multiplier: 'm', score_factor: (v) => v >= 1 ? 35 : 25 }, // million
  { rx: /\$?\s*(\d+)\s*k(?:il)?o?\b/i, multiplier: 'k', score_factor: (v) => v >= 700 ? 30 : v >= 400 ? 25 : v >= 200 ? 20 : 15 },
  { rx: /\$\s*(\d{3,})\s*(?:mxn|pesos|usd|dolares|dólares)?/i, multiplier: 'raw', score_factor: (v) => v >= 1000000 ? 35 : v >= 700000 ? 30 : v >= 400000 ? 25 : v >= 200000 ? 20 : v >= 50000 ? 15 : 0 },
];

// Plan keywords (lead explicitly mentions tier)
const PLAN_KEYWORDS = {
  'black more': 35,
  'black': 30,
  'gold': 25,
  'silver': 20,
  'bronze': 15,
};

function scoreCapital(allLeadMessages) {
  const fullText = allLeadMessages.join(' ').toLowerCase();
  let bestScore = 0;

  // Check plan keywords
  for (const [keyword, score] of Object.entries(PLAN_KEYWORDS)) {
    if (fullText.includes(keyword)) bestScore = Math.max(bestScore, score);
  }

  // Check capital amounts
  for (const pattern of CAPITAL_PATTERNS) {
    const m = fullText.match(pattern.rx);
    if (m) {
      const value = parseFloat(m[1].replace(',', '.'));
      bestScore = Math.max(bestScore, pattern.score_factor(value));
    }
  }

  return Math.min(35, bestScore);
}

// ─────────────────────────────────────────────────────────
// Intent signals — words/phrases that indicate buying intent
// ─────────────────────────────────────────────────────────
const INTENT_TIERS = {
  // Tier 1 — explicit close intent (10 puntos cada uno, max 20)
  tier1: [
    /\b(ya\s*(quiero|estoy\s*listo|firmo|firma|firmamos))\b/i,
    /\b(vamos|agend[ae]mos)\b/i,
    /\bcu[áa]ndo\s*podemos\s*hablar\b/i,
    /\blisto\s*para\s*(firma|invertir|aportar)\b/i,
    /\bme\s*decid[ío]\b/i,
    /\bs[íi]\s*claro\s*agend\b/i,
  ],
  // Tier 2 — strong interest (5 puntos cada uno, max 10)
  tier2: [
    /\bme\s*interesa\s*(mucho|bastante|demasiado)\b/i,
    /\bqu[ée]\s*sigue\b/i,
    /\bcu[áa]ndo\s*nos?\s*ve(mos)?\b/i,
    /\bcu[áa]l\s*es\s*el\s*siguiente\s*paso\b/i,
    /\bcu[áa]nto\s*es\s*el\s*m[íi]nimo\b/i,
    /\bcomo\s*empi(ezo|ezar|ezamos)\b/i,
    /\bsesi[óo]n\b.*\b(jueves|viernes|lunes|martes|mi[ée]rcoles)\b/i,
  ],
  // Tier 3 — qualified curiosity (2 puntos cada uno, max 5)
  tier3: [
    /\bcontrato\b/i,
    /\bgarant[íi]a\b/i,
    /\briesgo\b/i,
    /\bplazo\b/i,
    /\bliquidez\b/i,
    /\bproyecto\b/i,
    /\baport(ar|aci[óo]n)\b/i,
  ],
};

function scoreIntent(allLeadMessages) {
  const fullText = allLeadMessages.join(' ');
  let score = 0;
  let t1 = 0, t2 = 0, t3 = 0;

  for (const rx of INTENT_TIERS.tier1) {
    if (rx.test(fullText)) { t1 += 10; }
  }
  for (const rx of INTENT_TIERS.tier2) {
    if (rx.test(fullText)) { t2 += 5; }
  }
  for (const rx of INTENT_TIERS.tier3) {
    if (rx.test(fullText)) { t3 += 2; }
  }

  score = Math.min(20, t1) + Math.min(10, t2) + Math.min(5, t3);
  return Math.min(20, score);
}

// ─────────────────────────────────────────────────────────
// Engagement — # of meaningful inbound messages
// ─────────────────────────────────────────────────────────
function scoreEngagement(inboundCount) {
  // 0 msg → 0, 1 → 2, 2-3 → 5, 4-7 → 10, 8-12 → 13, 13+ → 15
  if (inboundCount === 0) return 0;
  if (inboundCount === 1) return 2;
  if (inboundCount <= 3) return 5;
  if (inboundCount <= 7) return 10;
  if (inboundCount <= 12) return 13;
  return 15;
}

// ─────────────────────────────────────────────────────────
// Data captured — gave name/email/phone
// ─────────────────────────────────────────────────────────
function scoreDataCaptured(lead) {
  let score = 0;
  if (lead.full_name || lead.wa_name) score += 3;
  if (lead.email) score += 7;          // email is gold
  if (lead.lead_phone) score += 5;     // separate from wa_phone counts
  return Math.min(15, score);
}

// ─────────────────────────────────────────────────────────
// Source — BOFU ads worth more than TOFU
// ─────────────────────────────────────────────────────────
function scoreSource(lead) {
  const funnel = (lead.funnel_stage || '').toLowerCase();
  const source = (lead.source || '').toLowerCase();
  if (funnel === 'bofu') return 10;
  if (funnel === 'mofu') return 7;
  if (funnel === 'rt') return 8; // retargeting = warm
  if (funnel === 'tofu') return 4;
  if (source === 'meta' || source === 'instagram') return 5;
  if (source === 'organic' || source === 'referral') return 7;
  return 3;
}

// ─────────────────────────────────────────────────────────
// Recency — penaliza leads viejos sin actividad
// ─────────────────────────────────────────────────────────
function scoreRecency(lastMessageAt) {
  if (!lastMessageAt) return 0;
  const hoursAgo = (Date.now() - new Date(lastMessageAt).getTime()) / (3600 * 1000);
  if (hoursAgo < 1) return 5;
  if (hoursAgo < 6) return 4;
  if (hoursAgo < 24) return 3;
  if (hoursAgo < 72) return 1;
  return 0;
}

// ─────────────────────────────────────────────────────────
// MAIN — calcula score completo
// Input: lead row from Supabase + array of inbound message bodies
// Output: integer 0-100
// ─────────────────────────────────────────────────────────
export function calculateLeadScore(lead, inboundMessages = []) {
  const messageBodies = inboundMessages
    .filter(m => m.direction === 'inbound')
    .map(m => m.body || '');

  const breakdown = {
    capital: scoreCapital(messageBodies),                                  // max 35
    intent: scoreIntent(messageBodies),                                    // max 20
    engagement: scoreEngagement(messageBodies.length),                     // max 15
    data: scoreDataCaptured(lead),                                         // max 15
    source: scoreSource(lead),                                             // max 10
    recency: scoreRecency(lead.last_message_at),                           // max 5
  };

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return {
    score: Math.min(100, total),
    breakdown,
    tier: total >= 80 ? 'HOT' : total >= 60 ? 'WARM' : total >= 40 ? 'LUKEWARM' : 'COLD',
    tier_emoji: total >= 80 ? '🔥' : total >= 60 ? '🌟' : total >= 40 ? '👀' : '❄️',
  };
}

// Helper: recalcula y persiste el score en Supabase
export async function recalcAndPersistScore(supabase, lead) {
  const { data: messages } = await supabase
    .from('messages')
    .select('direction, body, created_at')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: true })
    .limit(50);

  const result = calculateLeadScore(lead, messages || []);
  await supabase.from('leads').update({ lead_score: result.score }).eq('id', lead.id);
  return result;
}
