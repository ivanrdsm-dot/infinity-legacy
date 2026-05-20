# 📋 App Review Submission — Instagram Messaging

**Para:** Submit a Meta Developer Console — App "Infinity Legacy Operations" (798756486427167)
**Caso de uso:** Conectar con clientes en Instagram (Manage messaging on Instagram)

---

## 🔗 URLs requeridas (ya creadas)

| Campo | Valor |
|---|---|
| **Privacy Policy URL** | `https://www.infinitylegacy.io/privacy` |
| **Terms of Service URL** | `https://www.infinitylegacy.io/terms` |
| **Data Deletion URL** | `https://www.infinitylegacy.io/data-deletion` |
| **App Website** | `https://www.infinitylegacy.io` |
| **App Description** (texto en App Settings) | `AI-powered customer support assistant for Infinity Legacy, a Mexican financial services consultation firm. Handles inbound inquiries from prospective clients via Instagram DM, providing information about our investment access program and scheduling 60-minute consultations with our team.` |

---

## 📝 Justificaciones de permisos (en INGLÉS — Meta solo acepta inglés)

### Permission 1: `instagram_business_basic`

**¿Por qué lo necesitas?** (justification)

```
We use instagram_business_basic to retrieve the public profile information
(name, username) of users who initiate conversations with our Instagram
Business account @infinitylegacy.of. This allows our customer support
automation to address users by their first name in responses, creating a
personalized experience for prospective clients inquiring about our
financial services consultation program.

We do not access private data, only the public profile metadata that the
user makes visible. Profile information is stored temporarily (max 24 months)
solely to maintain conversation continuity across multiple sessions.
```

**¿Cómo lo usas?** (step-by-step)

```
1. A user sends a Direct Message to @infinitylegacy.of asking about our
   investment access program.
2. Our webhook receives the message and calls /me/instagram_business_basic
   endpoint with the user's IG ID to fetch their first name and username.
3. We pass this to our AI assistant (Claude) which uses the name to greet
   the user personally in the response.
4. The information is stored in our Supabase database, associated with the
   conversation thread, for continuity across multiple sessions.
5. The user can request deletion at any time via our data-deletion URL.
```

---

### Permission 2: `instagram_business_manage_messages`

**¿Por qué lo necesitas?** (justification)

```
We use instagram_business_manage_messages as the core functionality of our
customer support bot. Prospective clients send us Direct Messages on
Instagram asking about our investment consultation services. Our AI
assistant (Claude Sonnet 4.5) reads these messages and responds within
5-10 seconds with information about our program structure, requirements,
and how to book a 60-minute consultation.

This permission allows us to: (1) receive incoming messages via webhook,
(2) read message content and metadata, (3) send text responses back to
the same conversation thread.

We do NOT use this permission to send unsolicited messages, marketing
broadcasts, or messages outside of the 24-hour customer service window
after a user-initiated contact.
```

**¿Cómo lo usas?** (step-by-step)

```
1. User sends DM to @infinitylegacy.of from their personal Instagram.
2. Our webhook (https://www.infinitylegacy.io/api/ig-webhook) receives the
   messages.upsert event with the message content.
3. We store the inbound message in our database and pass it to our AI
   assistant Claude.
4. Claude generates a contextual response based on our system prompt
   (focused on financial services consultation, compliant with Mexican
   CNBV regulations).
5. We send the response back via POST to /me/messages within the same
   24-hour customer service window.
6. The user receives the response in their Instagram DM thread within
   5-10 seconds of their original message.

Example conversation:
  User: "Hola, vi su anuncio. ¿Cómo funciona el programa?"
  Bot:  "¡Hola! 👋 Programa de Acceso Infinity Legacy: aportación desde
         $50K MXN, portafolio diversificado bajo contrato de mandato.
         ¿Te gustaría agendar una sesión de 60 min con el equipo?"
```

---

### Permission 3: `pages_messaging` (si la App Review form lo pide)

**Justification:**

```
We use pages_messaging because Instagram Business accounts are linked to a
Facebook Page, and Meta's API architecture requires this permission to be
authorized in conjunction with instagram_business_manage_messages. We do
not actively use Messenger separately — our usage is exclusively to receive
and respond to Instagram DMs on the @infinitylegacy.of account.
```

---

## 🎥 Video Demo (30-60 segundos) — Lo que necesitas grabar

Meta requiere un video corto demostrando exactamente cómo se usan los permisos. Graba esto desde tu iPhone (puedes usar la grabadora de pantalla nativa de iOS):

### Storyboard del video (45 seg ideal):

**0:00-0:05** — Abre la app de Instagram en tu celular. Muestra que estás logueado con tu cuenta personal (NO @infinitylegacy.of).

**0:05-0:10** — Busca @infinitylegacy.of en el buscador. Toca el perfil para abrir.

**0:10-0:15** — Toca el botón "Mensaje" (Message) para abrir un chat nuevo.

**0:15-0:25** — Escribe un mensaje, ej: *"Hola, quiero saber más del Programa de Acceso de Infinity Legacy"*. Envía.

**0:25-0:35** — Espera. En 5-10 segundos llega la respuesta automática del bot (Claude). Muestra el contenido del mensaje.

**0:35-0:45** — (Opcional) Responde con otro mensaje y muestra que el bot responde de nuevo, mantiendo contexto.

**0:45-0:50** — Pantalla final, sin texto.

### Requerimientos técnicos del video:

- **Formato:** MP4, MOV, o WEBM
- **Resolución mínima:** 720p (recomendado 1080p)
- **Sin música ni voz** — solo el screen recording crudo
- **Audio:** OK silencio o sonidos del sistema
- **Tamaño:** máx ~50 MB (típicamente 5-20 MB para 45 seg)
- **Idioma de la conversación:** está bien en español, Meta no requiere inglés en el contenido del video

### Cómo grabar screen recording en iOS:

1. Ajustes → Centro de Control → añadir "Grabación de pantalla" si no la tienes
2. Centro de Control (desliza desde esquina superior derecha) → tap el círculo de grabación → empieza en 3 seg
3. Haz la demo
4. Termina yendo al Centro de Control y tap el círculo rojo, o el icono rojo arriba de la pantalla
5. El video se guarda en Fotos automáticamente

### Cómo subirlo a Meta:

Cuando estés en el App Review form, hay una sección "Screencast/Video" — sube el archivo MP4. Meta lo acepta directamente.

---

## 🚀 Pasos del submit en Meta Developer Console

1. Abre: https://developers.facebook.com/apps/798756486427167/app-review/permissions/

2. Verás lista de permisos. Click el botón **"Add to Submission"** o **"Request"** para cada uno de los 3 permisos:
   - `instagram_business_basic`
   - `instagram_business_manage_messages`
   - `pages_messaging` (si aparece)

3. Por cada permiso, llena:
   - **Justification:** pega el texto correspondiente de arriba
   - **Step-by-step instructions:** pega el texto correspondiente
   - **Screencast:** sube tu video demo (puedes usar el mismo para los 3 permisos)
   - **Platforms:** selecciona Web + Mobile

4. Sección **"App Verification"** (ya completada si Business Verification está aprobada):
   - Tax ID/RFC: IPS241017338
   - Documentación legal: tu acta constitutiva

5. Sección **"Settings"**:
   - Privacy Policy URL: `https://www.infinitylegacy.io/privacy`
   - Data Deletion Callback URL: `https://www.infinitylegacy.io/data-deletion`
   - Terms of Service URL: `https://www.infinitylegacy.io/terms`
   - Category: "Business and Pages"
   - Subcategory: "Business Tools" o "Customer Service"

6. Click **"Submit for Review"**

---

## ⏱️ Tiempo esperado de Meta

- **Standard Access Review:** 3-7 días laborales
- Notificación: por email al admin de la app (tú)
- Si rechazan: te dicen exactamente qué falta — corriges y re-submit

---

## 📌 Notas importantes

### Antes de submit, asegúrate de:

- ✅ Business Verification del portfolio está submitted (ya lo hiciste hoy)
- ✅ App está en modo **Live** (Published) — ya lo está
- ✅ Las 3 URLs (privacy, terms, data-deletion) son accesibles públicamente (verifica que no den 404)
- ✅ Video demo grabado y guardado en tu celular

### Si Meta rechaza:

Lo más común que piden:
1. "Video unclear" → graba de nuevo más claro, mejor iluminación
2. "Use case unclear" → ajusta justifications con más detalle del caso de uso
3. "Privacy policy missing field X" → agregamos lo que falta a la privacy policy
4. "App not live" → confirmar que está publicada

Todos son rápidos de corregir + re-submit.
