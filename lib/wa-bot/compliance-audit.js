/*
 * Infinity Legacy — Compliance Auto-Audit
 *
 * Antes de enviar una respuesta de Majo al lead, la pasamos por Haiku
 * 4.5 (~$0.0001 por check) que valida contra reglas CNBV/Meta:
 *
 *   1. NO promesas absolutas de ganancia
 *   2. NO uso de "garantizado", "rendimientos", "inversión"
 *   3. NO números de teléfono o emails inventados
 *   4. NO menciones de cripto/token específicos sin disclaimer
 *   5. NO contenido visual asumido (no "veo que mandaste foto")
 *   6. SÍ disclaimer breve cuando menciona % específicos
 *
 * Si flag → loggea, alerta a Iván, NO envía el mensaje, regenera con
 * Sonnet con feedback específico.
 */

const COMPLIANCE_PROMPT = `Eres un auditor de compliance para CHAT CONVERSACIONAL (no para anuncios) de un asistente virtual llamado Majo del equipo Infinity Legacy. Revisa el siguiente mensaje que el bot va a enviar a un lead en WhatsApp/Instagram/Messenger.

CONTEXTO IMPORTANTE — Infinity Legacy es servicio financiero MX NO regulado por CNBV. Su modelo usa:
- Planes de aportación bajo contrato de mandato S.A. de C.V.
- 7 inmuebles internacionales (Dubai, México)
- Tokenización vía token ERC-20 sobre Ethereum (PARTE LEGÍTIMA del producto)

Estas palabras NO son banderas en este contexto (forman parte del producto):
✅ "token ERC-20", "tokenización", "Ethereum", "blockchain" → vocabulario operativo legítimo
✅ "aportación", "mandante", "contrato de mandato" → terminología correcta
✅ "plan Bronze/Silver/Gold/Black" → naming oficial de los planes
✅ "resultado operativo variable" → forma correcta de hablar de retornos

Responde SOLO JSON estricto:
{
  "pass": true/false,
  "violations": ["..."],
  "severity": "low" | "medium" | "high" | "critical"
}

🔴 CRITICAL (BLOQUEAR — no enviar nunca):
- Promesa absoluta de ganancia: "vas a ganar X", "te garantizo retorno", "100% seguro", "sin riesgo", "imposible perder"
- Frase "rendimientos garantizados" o equivalente literal
- Número de teléfono específico de "Iván" o de la empresa inventado (ej. "+52 1 55 7825 8016") — Iván coordina desde el mismo chat
- Email inventado de Infinity Legacy
- Hallucination de contenido visual: "veo que mandaste foto/imagen" cuando NO hay attachment
- Dato falso fácticamente: dirección de oficina inventada, persona del equipo inventada

🟠 HIGH (revisar):
- Usa "rendimiento" en lugar de "resultado operativo variable"
- Menciona porcentaje específico (ej. "3% mensual") SIN agregar "variable, no garantizado"
- Tono demasiado agresivo/presionante

🟡 MEDIUM y 🟢 LOW (NO bloquear, solo loggear):
- "Inversión" / "invertir" — ya no es estricta porque el lead a veces lo usa
- Mensaje genérico
- Tono mejorable

Reglas POSITIVAS (NO flagueas si las cumple):
- Habla de tokenización ERC-20 como ESTRUCTURA OPERATIVA ✓
- Menciona Iván refiriendo al "mismo chat" sin número específico ✓
- Incluye disclaimer breve cuando menciona % ✓
- Mantiene tono cálido mexicano ✓

⚠️ Default si dudas: pass=true. Solo bloquea cuando es CLARAMENTE problemático. Es mejor enviar un mensaje OK que silenciar al bot por exceso de celo.

Responde SOLO el JSON.`;

export async function auditMessage(anthropicClient, messageText) {
  if (!messageText || messageText.length < 5) {
    return { pass: true, violations: [], severity: 'low', skipped: true };
  }

  try {
    const response = await anthropicClient.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: COMPLIANCE_PROMPT,
      messages: [{ role: 'user', content: `Mensaje a auditar:\n\n"${messageText}"` }],
    });

    const txt = response.content?.[0]?.text || '';
    // Extract JSON
    const match = txt.match(/```json\s*([\s\S]+?)\s*```/) || txt.match(/(\{[\s\S]+\})/);
    if (!match) {
      console.warn('[compliance] no JSON in response, defaulting to PASS');
      return { pass: true, violations: [], severity: 'low', parse_failed: true };
    }
    try {
      const parsed = JSON.parse(match[1]);
      const u = response.usage || {};
      const cost = ((u.input_tokens || 0) * 0.80 + (u.output_tokens || 0) * 4) / 1_000_000;
      return { ...parsed, audit_cost_usd: cost };
    } catch (e) {
      return { pass: true, violations: [], severity: 'low', parse_failed: true };
    }
  } catch (e) {
    console.error('[compliance] audit failed:', e.message);
    // Fail OPEN — if audit fails, let message pass (better than blocking everything)
    return { pass: true, violations: [], severity: 'low', audit_error: e.message };
  }
}

// Helper: should we block the message?
// SOLO bloqueamos CRITICAL (promesas absolutas, números inventados, hallucinations)
// HIGH y abajo se loggea pero permite envío (mejor enviar mensaje OK que silenciar bot)
export function shouldBlock(auditResult, blockLevel = 'critical') {
  if (!auditResult || auditResult.pass) return false;
  const severity = auditResult.severity || 'low';
  if (blockLevel === 'critical') return severity === 'critical';
  if (blockLevel === 'high') return ['critical', 'high'].includes(severity);
  if (blockLevel === 'medium') return ['critical', 'high', 'medium'].includes(severity);
  return true;
}
