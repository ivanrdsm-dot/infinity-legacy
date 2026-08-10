# 🎯 Roadmap — Lo que falta para que Infinity Legacy sea EL mejor sistema

**Status actual:** sistema funcional end-to-end (bot + dashboard + tracking + DB).
**Status target:** sistema operacionalmente excelente que escala a 100+ leads/día sin que tú toques una sola pieza manual.

---

## 🟢 Mejoras P0 — Críticas, hoy/mañana (impact ≥ effort × 5)

### 1. **Auto-reload de créditos Anthropic** ⚡
**Problema:** hoy se quedó sin saldo y el bot dejó de responder. Pierdes leads.
**Fix:** en console.anthropic.com → Settings → Billing → Auto-reload ON, threshold $10, top-up $50.
**Esfuerzo:** 30 seg
**Impact:** crítico — sin esto cualquier recarga manual = perder leads mientras duermes

### 2. **Tool calling de Claude (estructured outputs)**
**Problema:** Claude solo devuelve texto. No puede pausar bot, escalar a Iván, o marcar stage automáticamente vía API estructurada. Hoy lo hace por regex/keywords débiles.
**Fix:** agregar `tools` parameter a `anthropic.messages.create()` con:
- `set_stage(stage)` → updates Supabase
- `escalate_to_ivan(reason, urgency, context)` → manda WhatsApp a tu 5646665718
- `set_matched_plan(plan)` → BRONZE/SILVER/GOLD/BLACK/BLACK_MORE+
- `schedule_callback(when, reason)` → cron para retomar después
- `add_tag(tag)` → segmentar leads
**Esfuerzo:** 1-2 h
**Impact:** ALTO — Claude opera el CRM, no solo responde

### 3. **Webhook subscription a `message_status` (delivered/read)**
**Problema:** no sabes si tu mensaje llegó al cliente / si lo leyó.
**Fix:** suscribir el webhook al campo `message_status` en Meta. Guardar en Supabase. Mostrar ✓✓ azul en dashboard.
**Esfuerzo:** 1 h
**Impact:** medio — visibilidad operativa importante

### 4. **Notificaciones push a Iván cuando hay lead high-intent**
**Problema:** tienes que abrir el dashboard. Si estás en el coche, perdiste el lead.
**Fix:** cuando Claude detecte intent alto (escalate_to_ivan, ticket $1M+, dice "agendar"), mandarte WhatsApp con resumen + link directo al dashboard del lead.
**Esfuerzo:** 30 min (lógica ya existe, solo falta wiring)
**Impact:** ALTO — todos los high-intent llegan a tu mano en segundos

### 5. **Audio messages**
**Problema:** muchos prospectos mexicanos mandan AUDIO. Bot hoy responde "[non-text]" → lead se va.
**Fix:** transcribir audio con Whisper API → pasar texto a Claude → bot responde normal.
**Esfuerzo:** 1 h
**Impact:** ALTO — México es WhatsApp-audio cultura. Estimo 30%+ leads se pierden por esto.

---

## 🟡 Mejoras P1 — Alto valor, esta semana

### 6. **Imágenes del cliente** (manda foto de calculadora, screenshot de propiedad, etc.)
**Fix:** Claude 4.5 ya es vision-capable. Descargar imagen + pasarla como `image` block → Claude responde contextual.
**Esfuerzo:** 1 h
**Impact:** medio-alto

### 7. **Templates aprobados de WhatsApp para outreach proactivo**
**Problema:** después de 24h sin mensaje del lead, NO puedes escribirle texto libre (Meta lo bloquea — "24h customer service window"). Necesitas templates pre-aprobados por Meta.
**Fix:** crear 3-5 templates en Meta Business Manager:
- `inf_followup_24h` — "Hola {{1}}, regreso para saber si quedó alguna duda sobre el Programa de Acceso."
- `inf_session_recordatorio` — "Hola {{1}}, en 24h tenemos tu sesión con el equipo. Hora: {{2}}."
- `inf_session_post` — "Hola {{1}}, ¿cómo te fue en la sesión de ayer? ¿Resolvimos todas las dudas?"
**Esfuerzo:** 30 min crear + 24-48h aprobación Meta
**Impact:** ALTO — sin esto, leads >24h sin respuesta = lead muerto

### 8. **Lead scoring sofisticado**
**Problema:** hoy `lead_score` siempre = 0. No segmentas hot vs cold.
**Fix:** algoritmo:
- +10 ticket BLACK/BLACK_MORE+
- +15 dice "ya quiero firmar / vamos / estoy listo"
- +10 calculadora completada en web
- +5 cada mensaje del lead (engagement)
- -5 si pasa 24h sin responder
- -20 si dice "no me interesa"
Mostrar lead score en dashboard con código de color.
**Esfuerzo:** 1-2 h
**Impact:** medio-alto — priorización automática

### 9. **A/B testing del system prompt**
**Problema:** una sola versión del prompt. No sabes cuál convierte mejor.
**Fix:** dos prompts (A: actual, B: más cierre-agresivo). Asignar leads 50/50 por hash(wa_phone). Métrica: % leads que llegan a stage CLOSING.
**Esfuerzo:** 2 h
**Impact:** medio — mejora compounding del prompt

### 10. **Voice notes outbound**
**Problema:** todo es texto. Hay clientes que valoran un audio del equipo.
**Fix:** cuando un lead llega a CLOSING, mandar un audio pre-grabado tuyo de 30 seg "te conecto con Iván del equipo". O usar ElevenLabs/Cartesia para sintetizar.
**Esfuerzo:** 2-3 h
**Impact:** medio — solo para BOFU

---

## 🔵 Mejoras P2 — Valor sostenido, próximas 2 semanas

### 11. **Pre-check de anuncios (✅ YA EXISTE — `/ad-precheck.html`)**
Construido hoy. Falta: que detecte imagen también via Claude Vision.

### 12. **Auto-rotation de creativos cuando uno se desactiva**
**Fix:** cron diario que pulle anuncios `WITH_ISSUES` → notifica Iván → ofrece subir un rewrite del precheck.
**Esfuerzo:** 2 h
**Impact:** medio

### 13. **Cost tracking por lead**
**Problema:** no sabes cuánto cuesta cada lead en Claude $.
**Fix:** ya guardamos `llm_cost_usd` por mensaje. Aggregator por lead en dashboard + comparativa vs gasto en ads.
**Esfuerzo:** 1 h
**Impact:** medio — visibilidad de unit economics

### 14. **Sentry / error tracking + alertas**
**Problema:** si el webhook crashea, te enteras manual.
**Fix:** integrar Sentry (free tier) → alerta en email/WhatsApp cuando hay error.
**Esfuerzo:** 30 min
**Impact:** alto cuando se rompe algo

### 15. **Multi-language detection**
**Problema:** si llega un lead en inglés (Dubai, Miami), bot responde en español → confusión.
**Fix:** detectar idioma del mensaje, ajustar response language. Claude lo hace solo si le pasas hint.
**Esfuerzo:** 30 min
**Impact:** bajo-medio (mercado actual es MX)

### 16. **Dashboard de Ads + WA unificado**
**Problema:** hoy son 2 dashboards separados. Quieres ver "gasté $X en ads → llegaron Y leads → Z están en CLOSING".
**Fix:** página overview con CPL real, CAC, LTV estimado.
**Esfuerzo:** 3 h
**Impact:** ALTO para decisiones de presupuesto

### 17. **Backup automático de Supabase**
**Problema:** si se borra algo por error, no hay recovery.
**Fix:** cron diario que dumpea tablas a R2/S3 (Cloudflare R2 gratis hasta 10GB).
**Esfuerzo:** 1 h
**Impact:** alto cuando lo necesitas

### 18. **Inactivity ping en dashboard**
**Problema:** abres dashboard a las 8am, no lo cierras. A las 12pm sigue abierto consumiendo Vercel invocations.
**Fix:** después de 30 min de inactividad real, pausar polling automático con prompt "¿Sigues ahí?".
**Esfuerzo:** 15 min
**Impact:** bajo (cost saving)

### 19. **Slack/Discord integration para el equipo**
**Si crece el equipo:** notificaciones a un canal de Slack con cada escalación, daily summary, alertas.
**Esfuerzo:** 1 h
**Impact:** N/A hoy, alto cuando haya equipo

---

## 🟣 Mejoras P3 — Futuro / nice-to-have

### 20. **HubSpot / Salesforce export** (CRM enterprise para investors)
### 21. **WhatsApp Business Calling API** (cuando salga, hoy es preview)
### 22. **Voice cloning de Iván** para mensajes de welcome (ElevenLabs)
### 23. **Auto-generación de creativos** (Claude + DALL-E / Flux) — pero CADA imagen necesita precheck antes de subir
### 24. **Sentiment analysis** del lead en tiempo real (frustrado, dudoso, entusiasta) → ajusta tono del bot
### 25. **Predicción de churn** (clientes existentes que probablemente cancelen contrato → outreach proactivo)
### 26. **Dashboard pública limitada para socios/inversionistas** (KPIs sin PII)
### 27. **Mobile app PWA** del dashboard para que lo abras desde iPhone como app nativa
### 28. **Compliance audit log** (record de cada mensaje del bot + cada respuesta — útil si CNBV pregunta)

---

## 📊 Quick wins en orden de ROI

Si tuviera que elegir las **3 cosas a hacer mañana mismo** después del go-live del número real:

1. **Audio messages** (#5) — pierdes ~30% de leads sin esto
2. **Tool calling de Claude** (#2) — Claude opera el CRM solo
3. **Notificaciones push a Iván** (#4) — high-intent en tu mano en segundos

Total: ~3 horas de trabajo → sistema ya es 10x más capable.

---

## 🧮 Cálculo de costos operativos esperados

Asumiendo 30 leads/día, 8 mensajes promedio por conversación:

| Recurso | Costo unitario | Mensual |
|---|---|---|
| Claude Sonnet 4.5 inbound msg | $0.003 promedio | 30 × 8 × 30 = 7,200 msgs × $0.003 = **$22 USD** |
| Claude follow-ups (cron) | $0.002 | 30 × 6 × 30 = 5,400 × $0.002 = $11 USD |
| Whisper transcription (si audio enabled) | $0.006/min | 30 × 2 × 30 = 1,800 audios × ~30s = 900 min × $0.006 = $5 USD |
| Supabase | Free tier hasta 500MB DB | $0 |
| Vercel | Free tier hasta 100GB bandwidth + 100h func | $0 |
| WhatsApp Cloud API | 1,000 conv gratis/mes, después $0.06 | $0 (al inicio) |
| **Total mensual estimado** | | **~$38-50 USD** |

A 30 leads/día con CPL razonable $100 MXN → spend ads $3000 MXN/día = $90K MXN/mes. El backend cuesta ~$1K MXN. **0.5% del gasto en ads.** Brutalmente eficiente.

---

**Para arrancar production-grade mañana:** focus en P0 (items 1-5). Total ~5h de trabajo. Después arrancas anuncios sin miedo.
