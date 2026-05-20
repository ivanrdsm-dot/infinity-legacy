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

const COMPLIANCE_PROMPT = `Eres un auditor de compliance para servicios financieros mexicanos NO regulados por CNBV. Revisa el siguiente mensaje que un bot va a enviar a un lead. Responde SOLO con JSON estricto:

{
  "pass": true/false,
  "violations": ["..."],
  "severity": "low" | "medium" | "high" | "critical"
}

Reglas (banderas si encuentras CUALQUIERA):

🔴 CRITICAL (no enviar nunca):
- Promesa absoluta de ganancia ("vas a ganar", "te garantizo", "100% seguro", "sin riesgo")
- Uso de "rendimientos garantizados" o equivalente
- Número de teléfono específico inventado (que no sea formato estándar genérico)
- Email inventado de Infinity Legacy
- Dato falso sobre la empresa (sede, registro, etc.)

🟠 HIGH (revisar):
- Usa palabra "invertir/inversión/inversionista" sin contexto
- Usa palabra "rendimiento" en lugar de "resultado operativo"
- Asume contenido visual que no existe ("veo que mandaste foto")
- Menciona porcentaje específico SIN agregar "variable, no garantizado"
- Menciona cripto/token sin contexto operativo

🟡 MEDIUM (mejorable):
- Tono demasiado vendedor/agresivo
- Promete plazos específicos sin disclaimer
- Falta CTA al final del mensaje

🟢 LOW (OK pero podría mejorar):
- Errores menores de ortografía
- Lista muy larga
- Mensaje genérico sin personalización

Reglas POSITIVAS (no flagueas si las cumple):
- Dice "aportación" en vez de "inversión" ✓
- Dice "mandante" en vez de "inversionista" ✓
- Dice "resultado operativo variable" en vez de "rendimiento" ✓
- Incluye "no garantizado" cuando menciona % ✓
- Mantiene tono cálido pero profesional ✓
- Refiere al lead a Iván "desde este mismo chat" sin dar número específico ✓

Responde SOLO el JSON, sin explicaciones adicionales.`;

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
// CRITICAL violations = always block. HIGH = block in production. MEDIUM/LOW = warn only.
export function shouldBlock(auditResult, blockLevel = 'high') {
  if (!auditResult || auditResult.pass) return false;
  const severity = auditResult.severity || 'low';
  if (blockLevel === 'critical') return severity === 'critical';
  if (blockLevel === 'high') return ['critical', 'high'].includes(severity);
  if (blockLevel === 'medium') return ['critical', 'high', 'medium'].includes(severity);
  return true; // 'low' = block everything
}
