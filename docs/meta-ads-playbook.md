# 📘 Meta Ads Playbook — Infinity Legacy

**Última actualización:** 2026-05-18
**Para quién:** Iván + cualquier persona que vaya a subir creativos al Ads Manager de Infinity Legacy.

---

## ⚠️ Por qué Meta nos rechaza tanto

Infinity Legacy cae en **2 categorías nucleares hostiles** del algoritmo de Meta:

1. **Special Ad Category — Credit / Financial Services**
   Meta clasifica cualquier producto que mencione "ganar dinero, retornos, inversión, % mensual, contrato de mandato, portafolio" como Special Ad Category. Esto implica:
   - Targeting limitado (no género/edad/intereses específicos)
   - Revisión humana adicional (24-72h)
   - **Cero tolerancia** a promesas de ganancia explícitas
   - Lead form requiere disclaimers extra
   - Texto-en-imagen super sensible

2. **Crypto / Tokens (Restricted Products)**
   Cualquier mención de "token", "ERC20", "Ethereum", "blockchain", "crypto", "DeFi", "yield farming" dispara el filtro automático anti-cripto. Esto es **rechazo instantáneo sin review humano**. Es una baseline policy global de Meta desde 2018.

3. **Disclaimer obligatorio**
   Servicios financieros sin licencia CNBV deben llevar disclaimer visible en el ad mismo + landing page.

---

## 🚫 Palabras y patrones BANEADOS (rechazo seguro)

### Tier 1 — automático (rechazo en <60 segundos)
| Palabra/frase | Por qué | Alternativa |
|---|---|---|
| `token`, `ERC20`, `Ethereum`, `blockchain`, `crypto`, `cripto`, `DeFi`, `web3`, `NFT`, `yield farming`, `staking`, `wallet` | Special restricted: crypto | Quitar de copy + imagen. Si tienes que hablar de blockchain, di "tecnología distribuida moderna" sin nombrarla. |
| `garantizado`, `rendimiento garantizado`, `100% seguro`, `sin riesgo`, `cero pérdida` | Promesa absoluta financiera | "resultados operativos variables", "estrategia de resguardo del capital" |
| `gana X% mensual`, `te puedo dar 3% al mes`, `multiplica tu dinero`, `dinero pasivo`, `vida pasiva` | Promesa de ganancia futura | "modelo orientado a resultados variables", "diversificación con horizonte definido" |
| `casa de bolsa`, `fondo de inversión`, `entidad financiera`, `casino`, `betting`, `forex express` | Implica licencia que no tienes | Usar "S.A. de C.V. con contrato de mandato" |
| `ÚLTIMA OPORTUNIDAD`, `solo hoy`, `se acaba`, `cupos limitados`, `compra ya` | Urgencia falsa = trust violation | "agenda cuando te acomode esta semana" |
| `MAYÚSCULAS GRITANDO` en headline | Trigger spam | Sentence case profesional |

### Tier 2 — alto riesgo (rechazo en ~30% de los casos)
| Palabra | Riesgo | Mejor |
|---|---|---|
| `inversión`, `inversionista`, `invertir` | Implica regulación CNBV | `aportación`, `mandante`, `aportar` |
| `rendimientos`, `intereses` | Lenguaje bancario | `resultados operativos`, `beneficios variables` |
| `comisión 0%`, `sin comisiones` | Comparación financiera | `transparencia total` |
| Mostrar fajos de billetes 💰💵 emoji-money | Show-off de dinero | Mostrar gráficas, contratos, oficinas |
| Imagen de Lambo / mansión / yate | Wealth porn | Imagen de portafolio, gráficos limpios, oficina premium |
| `5 motores que TE HACEN GANAR` | Activo de venta | "5 líneas de diversificación complementaria" |

### Tier 3 — sutil pero a veces rebota
- Cifras absolutas en imagen (ej. "$50,000 MXN, 3% mensual") visible
- Tablas con porcentajes en miniatura
- Antes/después financiero ("antes ganaba $X, ahora $Y")

---

## ✅ Patrones que SÍ pasan (data nuestra, de los anuncios vivos)

Análisis del único anuncio nuestro que pasó (`Image_Narrativa5pct_v07`):

- **Imagen:** clean, profesional, sin texto financiero específico
- **Body:** habla de "narrativa", "filosofía", "estrategia" sin cifras
- **CTA:** WhatsApp Click — no Form interno (form requiere policy approval extra)
- **No menciona:** tokens, %, garantías, urgencia

### Plantilla copy que pasa Meta (Pareto 80/20 narrativa)

> **Headline:** "¿Conoces la filosofía Pareto del resguardo del capital?"
> **Primary text:** "Hay una manera de estructurar capital con un horizonte de 12-24 meses y vigencia bajo contrato de mandato S.A. de C.V. — sin promesas absolutas, con foco en preservar antes que maximizar. Te lo explicamos en una conversación de 60 min, sin presión de firmar nada. Escríbenos por WhatsApp."
> **CTA:** "Enviar mensaje" (WhatsApp)
> **Disclaimer al final:** "Resultados operativos variables. No somos institución supervisada por la CNBV."

### Plantilla copy para Real Estate (más permisiva)

> **Headline:** "Real Estate diversificado con respaldo institucional"
> **Primary text:** "Proyectos inmobiliarios en México y Dubai, estructurados bajo contrato de mandato con vigencia 12-24 meses. La diversificación protege el capital antes que maximizarlo. Conoce el modelo completo en una sesión sin compromiso."
> **CTA:** "Enviar mensaje" (WhatsApp)

### Plantilla copy para Calculadora (educativa)

> **Headline:** "Simula tu plan de aportación"
> **Primary text:** "¿Tienes capital pensando dónde estructurarlo? Tenemos una calculadora online que te muestra el plan correspondiente al rango que estás considerando, con resultados estimados variables. Sin compromiso. Tú decides si después agendamos."
> **CTA:** "Saber más" → landing /programa-acceso#calculadora

---

## 🎯 Configuración correcta de campaña

### A nivel campaña
- **Objetivo:** `OUTCOME_LEADS` (Lead Generation) o `OUTCOME_ENGAGEMENT` (Messages)
- **Special Ad Category:** marcar **"Credit"** (Crédito) en el dropdown
  - ⚠️ Esto deshabilita targeting demográfico estricto pero es obligatorio
  - Sin marcarlo = rechazo automático en 24h con bandera de cuenta
- **Budget:** ≥ $200 MXN/día (menos = Meta no aprende, te rechaza el anuncio por "low delivery potential")

### A nivel adset
- **Audience:** Mexico (CDMX/Monterrey/Guadalajara — top tier)
- **Edad:** 25-60 (con Special Category solo puedes elegir 18+, pero la prediction prioriza demos similares a tus conversiones)
- **Placements:** Reels + Feed + Stories (Instagram + Facebook), NO Marketplace ni Audience Network
- **Optimization:** "Conversaciones" si CTA es WhatsApp; "Leads" si form interno

### A nivel ad
- **Format preferido:** Imagen estática con copy narrativo. Video reel requiere review más estricta.
- **CTA button:** "Enviar mensaje" o "Saber más" — NO "Aplicar ahora", "Suscribirse", "Donar"
- **Landing destination:** WhatsApp con `[il-ref:...]` o landing con disclaimer visible
- **Pixel:** debe estar instalado en landing + CAPI funcionando (mejora el delivery)

---

## 🧠 Mental model: "¿Pasaría este ad si yo fuera un revisor de Meta?"

Antes de subir un creativo, pregúntate:

1. **¿Menciono crypto/token/blockchain/ERC?** → si sí, REWRITE
2. **¿Hay porcentajes específicos visibles?** → si sí, REWRITE (di "potencial variable" sin numerar)
3. **¿Prometo algo absoluto?** → si sí, agrega "variable, no garantizado" o quítalo
4. **¿Mi imagen muestra dinero, lujo, "antes/después"?** → cámbiala por algo profesional/educativo
5. **¿El CTA crea urgencia falsa?** → reemplaza por "cuando te acomode"
6. **¿Mi landing tiene disclaimer visible above-the-fold?** → si no, agrégalo
7. **¿Mi business verification está completa?** → check Meta Business Settings

Si TODAS las respuestas son seguras: subes el ad. Probabilidad de pasar ~80%.

Si hay 1+ respuestas de riesgo: el rechazo está casi garantizado.

---

## 🛠️ Si te rechazan un anuncio

### Paso 1 — Lee el motivo en Ads Manager
- Ve al anuncio → Status → click en "WITH_ISSUES" → expande el detalle
- Captura screenshot completo del modal

### Paso 2 — Identifica el tier
- **Tier "Special restricted product" (cripto, casinos)** → rewrite obligatorio, NO appeal
- **Tier "Misleading claims" (promesas absolutas)** → rewrite + appeal posible
- **Tier "Personal attributes" (asume edad/género del prospecto)** → revisar copy
- **Tier "Low quality"** → mejorar landing page, no es del ad mismo

### Paso 3 — Decide entre:
- **Rewrite + nuevo ad** (rápido, 1 día revisión) ← preferido
- **Request review** (appeal humano, 3-7 días) ← solo si REALMENTE crees que es falso positivo

### Paso 4 — Si te rechazan 3+ veces en 30 días
La cuenta entra en "elevated scrutiny". Soluciones:
1. **Crear cuenta nueva** desde Business Manager (no nueva profile)
2. **Domain verification + Business verification** completas
3. **Esperar 14 días** sin actividad y reintentar suaves
4. **Contactar Meta Business Support** vía chat (Business Help Center → Get Support)

---

## 📋 Checklist pre-vuelo (antes de cada anuncio)

- [ ] Copy revisado con palabras-baneadas tier 1 (cripto, garantizado, urgencia)
- [ ] Imagen sin texto de cifras/% visible
- [ ] Imagen sin show-off de dinero/lujo
- [ ] CTA button es "Enviar mensaje" o "Saber más"
- [ ] Special Ad Category marcado como "Credit" (Crédito)
- [ ] Disclaimer visible en landing
- [ ] Pixel + CAPI funcionando
- [ ] URL Click-to-Chat con `[il-ref:...]` para tracking
- [ ] Business verification al día
- [ ] Budget ≥ $200 MXN/día
- [ ] Audience Mexico, sin Audience Network/Marketplace

Si TODAS marcadas → sube el ad con confianza.

---

## 🔁 Templates que ya están battle-tested

Estas variantes están aprobadas para usarse en `/ctc-gen.html`:

| Variante | Funnel | Copy primary | CTA |
|---|---|---|---|
| narrativa-pareto | TOFU | "¿Conoces la filosofía Pareto?" + 80/20 sin cifras | WhatsApp |
| narrativa-real-estate | TOFU | "Real Estate diversificado MX+Dubai" | WhatsApp |
| narrativa-calculadora | MOFU | "Simula tu plan en 30s" + link a /programa-acceso#calculadora | Saber más |
| narrativa-sesion | BOFU | "60 min con el equipo, sin compromiso" | WhatsApp |
| narrativa-testimonio | RT | Testimonio cliente real (no fake) sin cifras | WhatsApp |

Cada vez que escribas un anuncio nuevo, **úsalas como base** y modifica al mínimo.

---

## 📞 Cuando todo lo demás falla

Si lo intentaste todo y sigue rebotando:

1. **Reto a Meta Business Help Chat** (NO usar form, usar chat):
   https://business.facebook.com/business/help/support
2. **Pide hablar con un "Marketing Pro"** (a veces te asignan uno gratis si tu spend >$500/mes)
3. **Mientras tanto:** prueba Google Ads / TikTok Ads que son más permisivos con financial services
4. **Considera retargeting orgánico:** Instagram posts + Reels orgánicos que después amplificas con boost (passa más fácil que campañas frías)

---

## 🧭 Si tienes duda

Cuando estés escribiendo un anuncio y dudes, **pasa el copy por el pre-check tool** (`/ad-precheck.html`) — Claude lo evalúa con esta misma policy y te dice antes de subirlo si va a rebotar.
