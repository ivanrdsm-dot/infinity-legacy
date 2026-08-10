/*
 * Infinity Legacy — Ad Pre-Check
 *
 * Antes de subir un creativo a Meta, este endpoint lo evalúa con
 * Claude Sonnet 4.5 contra el playbook de Meta Ads Policy + nuestra
 * historia de rechazos (cripto/promesas/urgencia/etc).
 *
 * Output:
 *   - risk_score: 0-100 (probabilidad de rechazo)
 *   - severity: "low" | "medium" | "high" | "blocked"
 *   - flags: array de issues específicos detectados
 *   - rewrite: copy reescrito que pasa Meta
 *   - keep: qué del copy original SÍ funciona y no tocar
 *
 * Auth: misma DASHBOARD_TOKEN.
 */

import Anthropic from '@anthropic-ai/sdk';

let _anthropic = null;
function getAnthropic() {
  if (_anthropic) return _anthropic;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
  _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

const SYSTEM_PROMPT = `Eres un revisor experto de Meta Ads Policy especializado en servicios financieros mexicanos no-regulados (Special Ad Category: Credit). Tu trabajo es predecir si un creativo va a ser rechazado por Meta y dar una versión que SÍ pase.

# CONTEXTO CRÍTICO: Infinity Legacy
- Es S.A. de C.V. (NO institución de crédito, NO casa de bolsa, NO entidad CNBV)
- Producto: Programa de Acceso bajo contrato de mandato
- 5 planes: Bronze ($50K MXN) hasta Black More+ ($1M+)
- Diversificación: 40% real estate, 28% trading institucional, 20% flipping, 10% nodos blockchain, 2% DeFi
- Resguardo: Lloyd's 1M USD en línea de trading

# REGLAS DE META QUE DEBES VERIFICAR

## TIER 1 (rechazo automático, severity="blocked")
Si el creativo menciona CUALQUIERA de estos → severity blocked:
- "token", "ERC20", "Ethereum", "blockchain", "crypto", "cripto", "DeFi", "web3", "NFT", "yield farming", "staking", "wallet"
- "garantizado", "rendimiento garantizado", "100% seguro", "sin riesgo", "cero pérdida"
- "casa de bolsa", "fondo de inversión", "casino", "forex express"
- Promesa de cifra absoluta de ganancia ("gana $X al mes", "multiplica tu dinero", "vida pasiva")

## TIER 2 (alto riesgo, severity="high")
- Palabras "inversión", "invertir", "inversionista", "rendimientos", "intereses"
- Cifras absolutas de % visibles (ej. "3% mensual", "36% anual")
- Imagen con fajos de billetes, autos lujo, mansiones, yates
- CTAs urgentes: "última oportunidad", "solo hoy", "cupos limitados", "compra ya"
- Texto en MAYÚSCULAS gritando

## TIER 3 (riesgo medio, severity="medium")
- Headline poco profesional / clickbait
- Comparación con bancos/bolsa
- "Antes/después" financiero
- Sin disclaimer

## SIGNOS POSITIVOS (que reducen riesgo)
- "Aportación", "mandante", "contrato de mandato"
- "Resultados operativos variables", "no garantizados"
- Tono narrativo educativo
- Imágenes profesionales, oficina, gráficos limpios
- Disclaimer "Resultados variables. No somos institución supervisada por la CNBV."
- CTA "Enviar mensaje" / "Saber más"

# OUTPUT FORMAT
Responde SIEMPRE en JSON estricto:
{
  "risk_score": 0-100,
  "severity": "low" | "medium" | "high" | "blocked",
  "verdict": "PASS" | "REVIEW" | "REJECT",
  "flags": [
    { "tier": 1|2|3, "issue": "...", "location": "headline|primary_text|image|cta", "evidence": "...palabra exacta..." }
  ],
  "rewrite": {
    "headline": "...",
    "primary_text": "...",
    "cta_button": "Enviar mensaje" | "Saber más",
    "disclaimer": "Resultados operativos variables. No somos institución supervisada por la CNBV."
  },
  "keep": ["...lista de elementos del copy original que SÍ funcionan y no hay que cambiar..."],
  "reasoning": "1-2 frases del por qué del veredicto"
}`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const token = (req.query.t || req.headers['x-dash-token'] || '').trim();
  if (!process.env.DASHBOARD_TOKEN) return res.status(500).json({ error: 'DASHBOARD_TOKEN missing' });
  if (token !== process.env.DASHBOARD_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  const { headline, primary_text, cta_button, image_description, landing_url } = req.body || {};
  if (!primary_text && !headline) return res.status(400).json({ error: 'headline or primary_text required' });

  const userMsg = `Evalúa este creativo para Meta Ads:

HEADLINE: ${headline || '(sin headline)'}
PRIMARY TEXT: ${primary_text || '(sin primary text)'}
CTA BUTTON: ${cta_button || '(no especificado)'}
IMAGEN DESCRIPCIÓN: ${image_description || '(no enviada)'}
LANDING URL: ${landing_url || '(no enviada)'}

Aplica el checklist Meta Ads Policy + Special Ad Category (Credit) + nuestra historia (rechazos previos por "token ERC20", "5 motores con %", "videos con % visible"). Devuelve JSON estricto.`;

  try {
    const response = await getAnthropic().messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    });

    const txt = response.content?.[0]?.text || '';
    // Extract JSON from response (Claude a veces wrappea en ```json ... ```)
    const match = txt.match(/```json\s*([\s\S]+?)\s*```/) || txt.match(/(\{[\s\S]+\})/);
    if (!match) {
      return res.status(200).json({ ok: false, raw: txt, error: 'No JSON found in Claude response' });
    }
    let parsed;
    try {
      parsed = JSON.parse(match[1]);
    } catch (e) {
      return res.status(200).json({ ok: false, raw: txt, error: 'JSON parse failed: ' + e.message });
    }

    return res.status(200).json({
      ok: true,
      ...parsed,
      tokens_in: response.usage?.input_tokens || 0,
      tokens_out: response.usage?.output_tokens || 0,
      cost_usd: ((response.usage?.input_tokens || 0) * 3 + (response.usage?.output_tokens || 0) * 15) / 1_000_000,
    });
  } catch (e) {
    console.error('[ad-precheck]', e.message);
    return res.status(500).json({ error: e.message });
  }
}
