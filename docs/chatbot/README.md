# 🤖 Infinity Legacy Chatbot — Setup Guide

> Sistema conversacional WhatsApp con Claude Sonnet 4.5, Supabase, follow-ups automáticos y takeover manual.

---

## 📂 Componentes ya construidos

| Archivo | Función | Estado |
|---|---|---|
| `api/wa-bot/system-prompt.md` | Cerebro del bot — personalidad, compliance, funnel | ✅ Listo |
| `api/wa-webhook.js` | Recibe mensajes WhatsApp, orquesta Claude, persiste en DB | ✅ Listo |
| `api/wa-cron-followup.js` | Cron 1min que dispara follow-ups automáticos | ✅ Listo |
| `docs/chatbot/supabase-schema.sql` | Schema DB completo (leads, messages, follow_ups, etc.) | ✅ Listo |

---

## 🚀 Setup en 5 pasos (cuando Business Verification pase)

### Paso 1 — Crear proyecto Supabase

1. Ir a [supabase.com](https://supabase.com) → New Project
2. Nombre: `infinity-legacy-chatbot`
3. Región: `us-east-1` (más cerca de Vercel)
4. Password DB: generar y guardar
5. Esperar 2-3 min hasta que termine el provisioning
6. **Database → SQL Editor → New query** → pegar contenido de `supabase-schema.sql` → Run
7. Copiar de **Settings → API**:
   - `URL` → variable `SUPABASE_URL`
   - `service_role secret` → variable `SUPABASE_SERVICE_ROLE_KEY` (server-side ONLY)

### Paso 2 — Configurar Anthropic API

1. Ir a [console.anthropic.com](https://console.anthropic.com)
2. **API Keys → Create Key** → nombre: `infinity-legacy-wa-bot`
3. Copiar la key (empieza con `sk-ant-`) → variable `ANTHROPIC_API_KEY`
4. **Settings → Billing → Auto-recharge** → cargar mínimo $20 USD para empezar

### Paso 3 — Configurar WhatsApp Cloud API (post Business Verification)

1. **Meta Business Manager → WhatsApp Accounts → Conectar número** (5566253065)
2. **Meta for Developers → Tu App → WhatsApp → API Setup**
3. Copiar:
   - `Phone Number ID` → variable `WA_PHONE_NUMBER_ID`
   - `Access Token` (de System User) → variable `WA_ACCESS_TOKEN`
   - `App Secret` (App Settings) → variable `WA_APP_SECRET`
4. Generar token aleatorio para webhook → variable `WA_VERIFY_TOKEN`
5. **Configurar webhook:**
   - URL: `https://www.infinitylegacy.io/api/wa-webhook`
   - Verify Token: el mismo valor de `WA_VERIFY_TOKEN`
   - Suscribirse a: `messages`, `message_status`

### Paso 4 — Variables de entorno en Vercel

```bash
# WhatsApp Cloud API
WA_VERIFY_TOKEN=<random_string>
WA_APP_SECRET=<meta_app_secret>
WA_ACCESS_TOKEN=<system_user_token>
WA_PHONE_NUMBER_ID=<phone_number_id>

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>

# Operación
IVAN_NOTIFY_NUMBER=525519385348
CALENDLY_LINK=https://calendly.com/infinitylegacy/sesion-60min
CRON_SECRET=<random_string_for_cron_auth>
```

Setup en Vercel:
```bash
cd "/Users/ivancadavieeco/PUBLICIDAD INFINITI/site"
vercel env add WA_VERIFY_TOKEN production
# ... etc para cada una
```

### Paso 5 — Agregar Vercel Cron

Editar `vercel.json` y añadir:

```json
"crons": [
  { "path": "/api/wa-cron-followup", "schedule": "* * * * *" }
]
```

### Paso 6 — Instalar dependencias

```bash
cd "/Users/ivancadavieeco/PUBLICIDAD INFINITI/site"
npm init -y
npm install @supabase/supabase-js @anthropic-ai/sdk
git add package.json package-lock.json node_modules.gitignore
```

(Si ya hay `package.json`, solo `npm install`).

---

## 🧪 Testing antes de conectar a WhatsApp real

### Test 1: Webhook responde a verificación de Meta

```bash
curl "https://www.infinitylegacy.io/api/wa-webhook?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=test123"
# Debe devolver: test123
```

### Test 2: Simular mensaje inbound

```bash
curl -X POST https://www.infinitylegacy.io/api/wa-webhook \
  -H "Content-Type: application/json" \
  -H "x-hub-signature-256: sha256=<calcular_con_app_secret>" \
  -d '{
    "entry": [{
      "changes": [{
        "field": "messages",
        "value": {
          "messages": [{
            "from": "525555555555",
            "id": "test_msg_1",
            "text": { "body": "Hola, quiero conocer el Programa de Acceso" },
            "type": "text"
          }],
          "contacts": [{ "profile": { "name": "Test User" } }]
        }
      }]
    }]
  }'
```

### Test 3: Ver en Supabase que el lead se creó

Dashboard de Supabase → Table editor → `leads` → debe aparecer el nuevo lead.

---

## 🎮 Cómo Iván toma control de una conversación

Desde el número personal de Iván (525519385348), enviar al número del bot (5566253065) estos comandos:

| Comando | Acción |
|---|---|
| `/yo 525551234567` | Pausa el bot para ese lead específico. A partir de aquí Iván contesta manual. |
| `/yo` (sin número) | Pausa el bot para el último lead que escribió |
| `/bot 525551234567` | Re-activa el bot para ese lead |
| `/escalar 525551234567` | Marca como urgente (priority='urgent') |
| `/cerrar 525551234567 won` | Marca como WON (firmó contrato) |
| `/cerrar 525551234567 lost` | Marca como LOST |
| `/nota 525551234567 [texto]` | Agrega nota interna al lead |

(Estos comandos los procesa un handler especial dentro de wa-webhook.js — pendiente de implementar en Fase 1 final).

---

## 📊 Costos esperados

| Volumen | Anthropic | Supabase | Vercel | WhatsApp | TOTAL |
|---|---|---|---|---|---|
| 50 leads/mes | $5 | $0 | $0 | $0 | **$5/mes** |
| 200 leads/mes | $20 | $0 | $0 | $0 | **$20/mes** |
| 500 leads/mes | $50 | $0 | $20 | $25 | **$95/mes** |
| 1000 leads/mes | $100 | $25 | $20 | $50 | **$195/mes** |

---

## 🛡️ Compliance integrado

El system prompt tiene reglas duras contra:
- Palabras prohibidas CNBV ("invertir", "rendimiento garantizado")
- Promesas absolutas de ganancia
- Mencionar entidades reguladas que NO somos
- Pedir datos sensibles (cuenta bancaria, NIPs)

Y mandatorio:
- Disclaimer cada vez que mencione cifras
- "Resultados operativos variables, no garantizados"
- Léxico mandante/aportación/contrato de mandato

---

## 🔥 Cuando todo esté conectado

El flujo será:

```
[Cliente click ad → wa.me con il-ref]
        ↓
[Llega mensaje a 5566253065]
        ↓
[/api/wa-webhook recibe]
        ↓
[Persiste en Supabase + parsea il-ref → guarda fuente del lead]
        ↓
[Si bot activo → Claude genera respuesta contextualizada]
        ↓
[Envía respuesta vía WA Cloud API → cliente la recibe]
        ↓
[Programa 6 follow-ups automáticos]
        ↓
[Si cliente responde → cancela follow-ups + continúa conversación]
[Si no responde a 5/10/30 min/1d/3d/7d → bot manda follow-up contextual]
        ↓
[Si lead Black More+ ($1M+) → bot ESCALA inmediatamente a Iván vía WA]
[Si Iván dice "/yo" → bot pausa para ese lead, Iván contesta manual]
[Si Iván dice "/bot" → bot reactiva]
```

---

## ⚠️ Lo que falta de Fase 1 (siguiente turno)

- [ ] Implementar el handler de comandos `/yo`, `/bot`, etc. en wa-webhook.js
- [ ] Implementar tool-calling de Claude para `escalate_to_ivan`, `set_stage`, `set_matched_plan`
- [ ] Dashboard UI en `/wa-dashboard` para que Iván vea conversaciones en vivo
- [ ] Simulador `/api/wa-simulate` para probar sin WhatsApp real

## ⚠️ Lo que falta de Fase 2 (post-Business Verification)

- [ ] Crear WhatsApp Business Account en el Portfolio
- [ ] Conectar el número 5566253065
- [ ] Configurar webhook en Meta
- [ ] Subir las env vars a Vercel
- [ ] Test end-to-end con un mensaje real
- [ ] Activar el cron de follow-ups
