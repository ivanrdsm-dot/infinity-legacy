/*
 * Infinity Legacy — Message Composer
 *
 * Endpoint que genera 3 borradores de respuesta para que Iván copie-pegue
 * en su WhatsApp manual. Usa el mismo system prompt del bot completo +
 * compliance dura + info del deck.
 *
 * Vars env requeridas:
 *   - ANTHROPIC_API_KEY (obligatorio)
 *   - DASHBOARD_TOKEN   (auth - reusamos el existente)
 *
 * Vars env opcionales (si están, loggea la conversación):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * POST con body JSON:
 *   {
 *     "customer_message": "Hola, ¿qué tan seguro es esto?",
 *     "context": "...mensaje previos del cliente (opcional)..."
 *   }
 *
 * Devuelve:
 *   {
 *     "ok": true,
 *     "variants": [
 *       { "tone": "Profesional cálido", "text": "..." },
 *       { "tone": "Breve y directo",   "text": "..." },
 *       { "tone": "Aspiracional",       "text": "..." }
 *     ],
 *     "cost_usd": 0.012
 *   }
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(process.cwd(), 'api/wa-bot/system-prompt.md'),
  'utf-8'
);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY missing' });
  }

  // Auth via token (mismo que dashboard)
  const token = (req.query.t || req.headers['x-token'] || '').trim();
  if (token !== process.env.DASHBOARD_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { customer_message, context = '' } = req.body || {};
  if (!customer_message || customer_message.trim().length < 2) {
    return res.status(400).json({ error: 'customer_message required' });
  }

  try {
    const composerInstruction = `
# 🎯 MODO COMPOSER — Genera 3 BORRADORES de respuesta

Iván te pasa el último mensaje del cliente. Tu trabajo: generar EXACTAMENTE 3 borradores de respuesta distintos, cada uno con un tono diferente, para que Iván elija y copie-pegue al WhatsApp del lead.

**Las 3 variantes obligatorias:**
1. **"Profesional cálido"** — Tono institucional pero humano. La opción default para 80% de casos.
2. **"Breve y directo"** — Para clientes apurados, en 1-2 frases máximo, mantiene compliance.
3. **"Educativo profundo"** — Para clientes que muestran dudas serias o quieren entender el modelo. Más largo, con disclaimer.

**Reglas:**
- TODAS las variantes deben respetar el compliance del system prompt (cero palabras prohibidas).
- TODAS las variantes deben sonar como mensaje de WhatsApp (no emails formales).
- Máximo 2-3 párrafos por variante (excepto Educativo Profundo que puede ser 4).
- Incluye emojis solo donde aporten claridad (máximo 1-2 por variante).
- Si la pregunta del cliente cae en una de las 5 dudas comunes del system prompt, USA esa respuesta como base.
- Si el mensaje tiene un \`[il-ref:...]\` parseable, NO lo menciones explícitamente.

**Formato de respuesta — JSON EXACTO:**

\`\`\`json
{
  "stage_detected": "INITIAL | QUALIFYING | EDUCATING | PRESENTING | CLOSING | NURTURING",
  "intent": "1 frase: qué quiere el cliente / objeción / pregunta",
  "ticket_signal": "BRONZE | SILVER | GOLD | BLACK | BLACK_MORE_PLUS | UNKNOWN — basado en lo que dice",
  "escalate_to_ivan": true | false,
  "escalate_reason": "(solo si escalate_to_ivan=true)",
  "variants": [
    { "tone": "Profesional cálido", "text": "..." },
    { "tone": "Breve y directo", "text": "..." },
    { "tone": "Educativo profundo", "text": "..." }
  ]
}
\`\`\`

NO escribas nada más allá del JSON. Solo el JSON.

# 📥 MENSAJE DEL CLIENTE
"""
${customer_message}
"""

${context ? `# 🗂️ CONTEXTO PREVIO\n"""\n${context}\n"""\n` : ''}

# 🎬 Tu turno
Genera el JSON ahora.
`;

    const start = Date.now();
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1600,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: composerInstruction }],
    });
    const ms = Date.now() - start;

    let raw = response.content?.[0]?.text || '';
    // Strip possible markdown fences
    raw = raw.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // Si falla parsing, intenta extraer el primer bloque JSON
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        parsed = JSON.parse(match[0]);
      } else {
        throw new Error('Claude returned non-JSON: ' + raw.substring(0, 200));
      }
    }

    const tin = response.usage?.input_tokens || 0;
    const tout = response.usage?.output_tokens || 0;
    const cost = (tin * 3 + tout * 15) / 1_000_000;

    return res.status(200).json({
      ok: true,
      ...parsed,
      latency_ms: ms,
      cost_usd: parseFloat(cost.toFixed(5)),
      tokens: { in: tin, out: tout },
    });
  } catch (e) {
    console.error('[Composer] error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
