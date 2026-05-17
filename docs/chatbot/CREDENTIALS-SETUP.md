# 🔐 Setup de cuentas externas — 15 minutos

> Pasos exactos para que Iván cree las 2 cuentas externas que necesita el chatbot. Después de esto el sistema está LIVE en modo simulador.

---

## ⏱️ Tiempo total: ~15 minutos

1. Supabase (5 min)
2. Anthropic (5 min)
3. Pasarme las 4 credenciales por WhatsApp (1 min)
4. Yo configuro Vercel (3 min)
5. Probamos el simulador (1 min)

---

## 1️⃣ Crear cuenta Supabase (5 min)

### Paso 1.1 — Sign up
1. Ir a [supabase.com](https://supabase.com)
2. **Sign up** con tu Google (`ivancadavieeco@hotmail.com` o el que prefieras)
3. Confirmar email si pide

### Paso 1.2 — Crear el proyecto
1. **New Project**
2. Organización: usa la que crea por default
3. Nombre del proyecto: `infinity-legacy-chatbot`
4. Region: `East US (North Virginia)` (más cerca de Vercel)
5. Database Password: **GENERA UNA RANDOM Y GUÁRDALA EN 1Password o equivalente** (la necesitarás)
6. Pricing: **Free tier** (suficiente para empezar)
7. Click **Create new project**
8. Espera ~2 minutos a que termine el provisioning

### Paso 1.3 — Aplicar el schema SQL
1. Una vez listo, en el menú izquierdo: **Database → SQL Editor**
2. Click **New query**
3. Abre en tu Mac el archivo:
   ```
   /Users/ivancadavieeco/PUBLICIDAD INFINITI/site/docs/chatbot/supabase-schema.sql
   ```
4. Copia TODO el contenido y pégalo en el SQL Editor de Supabase
5. Click **Run** (botón verde abajo)
6. Debe decir "Success. No rows returned"

### Paso 1.4 — Copiar las credenciales
1. En el menú izquierdo: **Project Settings (⚙️) → API**
2. Vas a ver 3 cosas que necesito:
   - **Project URL** — algo como `https://xxxxxxxxx.supabase.co`
   - **API Keys → anon public** — copiarla
   - **API Keys → service_role secret** — ⚠️ click "Reveal" para verla, copiarla
3. Mándame las 3 por WhatsApp

> ⚠️ **CRITICAL:** El `service_role` key es como una llave maestra. NUNCA la subas a GitHub ni la pongas en código frontend. Yo la pongo solo en variables de entorno de Vercel server-side.

---

## 2️⃣ Crear cuenta Anthropic (5 min)

### Paso 2.1 — Sign up
1. Ir a [console.anthropic.com](https://console.anthropic.com)
2. **Sign up** con email (`ivanrdsm@gmail.com` recomendado para separar de Hotmail)
3. Verificar email

### Paso 2.2 — Cargar saldo inicial
1. En el menú izquierdo: **Settings → Billing**
2. **Add payment method** — usar la Mastercard *3154 o la que prefieras
3. **Add credits** → cargar **$20 USD inicial** (rinde para ~200 conversaciones, suficiente para 2-3 semanas iniciales)
4. (Opcional) Activar **Auto-recharge** para que se recargue solo cuando baje a $10

### Paso 2.3 — Crear API Key
1. En el menú izquierdo: **API Keys**
2. **Create Key**
3. Nombre: `infinity-legacy-wa-bot`
4. Permission: **All** (default)
5. Click **Create**
6. Te muestra la key (empieza con `sk-ant-`) — ⚠️ **CÓPIALA AHORA, no la vuelves a ver**
7. Pégala en una nota segura y mándamela por WhatsApp

---

## 3️⃣ Pasarme las 4 credenciales

Mándame por WhatsApp en este formato exacto (copia-pega y rellena):

```
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
```

---

## 4️⃣ Lo que yo hago cuando recibo las credenciales (3 min)

1. Subir las 4 variables a Vercel (production)
2. Generar 2 secrets extra (`CRON_SECRET`, `SIMULATOR_TOKEN`)
3. Instalar dependencias npm
4. Deploy

Confirmo cuando esté listo.

---

## 5️⃣ Probar el simulador (5 min)

Una vez confirmado, podrás probar el bot completo SIN tener WhatsApp Cloud API. Te paso un comando como este:

```bash
curl -X POST https://www.infinitylegacy.io/api/wa-simulate \
  -H "Content-Type: application/json" \
  -H "x-sim-token: TU_SIMULATOR_TOKEN" \
  -d '{
    "phone": "525511111111",
    "sim_name": "Cliente Prueba",
    "message": "Hola, vi el anuncio. Estoy considerando aportar $500,000 MXN. [il-ref: src=meta cmp=il_prgacceso ad=image_narrativa5pct_v07]"
  }'
```

Te va a devolver la respuesta del bot literal, el plan que detectó, los tokens usados, el costo en USD, y el latency. Es la prueba de fuego antes de conectar WhatsApp real.

Y desde el dashboard `https://www.infinitylegacy.io/wa-dashboard?t=...` vas a ver la conversación en vivo, podrás tomar control, agregar notas, marcar WON/LOST.

---

## 📋 Estado después del setup

| Componente | Status |
|---|---|
| ✅ Supabase tablas creadas | LIVE |
| ✅ Claude API key configurada | LIVE |
| ✅ Webhook /api/wa-webhook | LIVE (esperando WA Cloud API para conectar a Meta) |
| ✅ Simulador /api/wa-simulate | LIVE (puedes probar el bot ya) |
| ✅ Cron follow-ups /api/wa-cron-followup | LIVE (corre cada 1 min) |
| ✅ Dashboard /wa-dashboard | LIVE (ves conversaciones reales) |
| 🟡 WhatsApp Cloud API conectado al bot | Bloqueado por Business Verification |
| 🟡 Número 5611357074 enviando/recibiendo via webhook | Bloqueado por Business Verification |

Cuando pase Business Verification, en 30 minutos conectamos lo último y el sistema está en producción completa.
