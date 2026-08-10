# Infinity Legacy — Naming Convention & UTM Taxonomy

**Versión:** 1.0
**Última actualización:** 2026-05-08
**Mantenido por:** Iván Cadavieco + Claude
**Aplica a:** Meta Ads, Google Ads, TikTok Ads, YouTube Ads, email, contenido orgánico

---

## ¿Por qué esto importa?

Sin convención estricta, en 60 días vas a tener 200+ campañas con nombres inconsistentes y será imposible:
- Comparar performance entre proyectos
- Auditar el gasto por funnel/audiencia/creativa
- Atribuir ventas reales al anuncio que las cerró
- Escalar a Dubai/USA con consistencia

Con esta convención, **cualquier persona puede leer un nombre y saber instantáneamente qué es**.

---

## Reglas globales

1. **Sin espacios.** Usar `_` para separar componentes mayores, `-` dentro de un mismo componente.
2. **Componentes grandes en `MixedCase`** (ej: `Montevinum`, `LAL1pct-WebVisitors`).
3. **Códigos de geo y dimensiones en `UPPERCASE`** (ej: `MX`, `BOFU`, `TOFU`).
4. **Fechas en formato ISO `YYYY-MM`** o `YYYY-MM-DD` cuando aplica.
5. **Siempre prefijo `IL_`** en Meta para identificar fácilmente la marca cuando haya múltiples portfolios.
6. **NUNCA editar un anuncio publicado** — duplicar y bumpear versión `v01 → v02`.
7. **UTMs en lowercase strict** (Meta acepta mayúsculas pero algunos analytics no normalizan bien).

---

## Estructura de Campaña

```
IL_[Proyecto]_[Funnel]_[Objetivo]_[Geo]_[YYYY-MM]
```

### Códigos válidos

| Componente | Valores |
|------------|---------|
| Brand prefix | `IL` |
| Proyecto | `Montevinum` `Azizi` `Kukulkan` `Hospital` `Citrus` `LuxuryClinics` `TownHouses` |
| Funnel | `TOFU` `MOFU` `BOFU` |
| Objetivo | `Reach` `Awareness` `Traffic` `Engage` `Conv` `LeadGen` `Msg` `Catalog` |
| Geo | `MX` `MX-CDMX` `MX-DiasporaUS` `AE` `MX+US` |
| Fecha | `YYYY-MM` (mes de lanzamiento) |

### Ejemplos

```
IL_Montevinum_BOFU_Conv_MX_2026-05
IL_Montevinum_TOFU_Reach_MX_2026-05
IL_Azizi_TOFU_Reach_MX-DiasporaUS_2026-05
IL_Kukulkan_BOFU_LeadGen_MX_2026-05
```

---

## Estructura de Ad Set

```
[NombreCampaña]__[Audiencia]_[Edad]_[Placement]
```

### Códigos de audiencia

| Tipo | Código | Ejemplo |
|------|--------|---------|
| Lookalike | `LAL[X]pct-[seed]` | `LAL1pct-WebVisitors`, `LAL3pct-Buyers` |
| Remarketing web | `RemktWeb[X]d` | `RemktWeb30d`, `RemktWeb90d` |
| Remarketing IG | `RemktIG-[criterio]` | `RemktIG-Engaged90d` |
| Remarketing CRM | `RemktCRM-[lista]` | `RemktCRM-Calientes` |
| Pixel custom audience | `PixelAct-[evento]` | `PixelAct-WhatsAppClick` |
| Cold (intereses) | `Int-[descriptor]-[ciudades]` | `Int-LujoFinanzas-CDMX-GDL-MTY` |
| Cold (broad) | `Cold-Broad` | `Cold-Broad` |

### Edad

`30-55`, `35-55`, `25-65` — siempre con guion entre min y max.

### Placement

| Código | Significado |
|--------|-------------|
| `Auto` | Advantage+ Placement (recomendado por defecto) |
| `FB-Feed` | Solo Facebook Feed |
| `IG-Feed` | Solo Instagram Feed |
| `IG-Reels` | Solo Instagram Reels |
| `IG-Stories` | Solo Stories de Instagram |
| `FB-IGFeed` | Feed de Facebook + Feed de Instagram |
| `Mobile-Only` | Solo móvil (sin desktop) |

### Ejemplos

```
IL_Montevinum_BOFU_Conv_MX_2026-05__LAL1pct-WebVisitors_35-55_Auto
IL_Montevinum_BOFU_Conv_MX_2026-05__RemktWeb30d_32-55_Auto
IL_Montevinum_BOFU_Conv_MX_2026-05__Int-LujoFinanzas-CDMX-GDL-MTY_35-55_Auto
```

---

## Estructura de Anuncio

```
[NombreAdSet]___[Formato]_[Hook]_[CTA]_v[##]
```

### Formato

| Código | Significado |
|--------|-------------|
| `Reel-15s` `Reel-30s` `Reel-60s` | Reel vertical con duración |
| `Video-30s` `Video-60s` | Video horizontal |
| `Carousel-3slides` `Carousel-5slides` `Carousel-10slides` | Carousel multi-tarjeta |
| `Image` | Imagen estática |
| `Story-15s` | Story vertical |
| `Coll` | Collection (catalog ad) |

### Hooks (catálogo, expandir según tests)

| Hook | Descripción |
|------|-------------|
| `AspiracionalDrone` | Vista aérea premium, lifestyle |
| `EducacionalTokenizacion` | Cómo funciona la inversión fraccionada |
| `TestimonioCliente` | Cliente real hablando |
| `UrgenciaPlazas` | "Solo quedan X unidades" |
| `ContrasteAntesDespues` | Lote vacío vs render terminado |
| `DesgloseRendimiento` | Números (ROI, plusvalía) |
| `LifestyleViñedo` | Cinematográfico: gente disfrutando |
| `Hook-NombreCustom` | Para tests específicos no catalogados |

### CTAs

| CTA código | Botón Meta |
|------------|-----------|
| `AgendaConsulta` | "Reservar" / "Más información" |
| `VerProyecto` | "Más información" |
| `EnviarMensaje` | "Enviar mensaje" (Click-to-WA) |
| `QuieroSaberMas` | "Más información" |
| `RegistroFormulario` | "Registrarse" |

### Versionado

`v01`, `v02`, `v03`... obligatorio. Cada cambio menor (copy, visual, voz) bumpea versión.

### Ejemplos

```
[…]_LAL1pct-WebVisitors_35-55_Auto___Reel-15s_AspiracionalDrone_AgendaConsulta_v01
[…]_LAL1pct-WebVisitors_35-55_Auto___Carousel-5slides_DesgloseTokenizacion_QuieroSaberMas_v01
[…]_LAL1pct-WebVisitors_35-55_Auto___Image_LogoOroSimplicidad_AgendaConsulta_v01
```

---

## UTM Taxonomy

Los UTMs son la **versión URL-safe lowercase** del nombre de campaña/ad/audiencia.

### Estructura

| Parámetro | Valor | Ejemplo |
|-----------|-------|---------|
| `utm_source` | Plataforma | `meta`, `google`, `tiktok`, `youtube`, `whatsapp`, `partner-mauricio` |
| `utm_medium` | Tipo de tráfico | `paid_social`, `cpc`, `display`, `email`, `organic_social`, `messaging`, `referral` |
| `utm_campaign` | Nombre campaña Meta lowercase | `il_montevinum_bofu_conv_mx_2026-05` |
| `utm_content` | Nombre anuncio simplificado | `reel-15s_aspiracionaldrone_agendaconsulta_v01` |
| `utm_term` | Audiencia (ad set) | `lal1pct-webvisitors_35-55` |

### Ejemplo end-to-end

**Anuncio Meta:**
```
IL_Montevinum_BOFU_Conv_MX_2026-05__LAL1pct-WebVisitors_35-55_Auto___Reel-15s_AspiracionalDrone_AgendaConsulta_v01
```

**URL en el botón del anuncio:**
```
https://www.infinitylegacy.io/projects/monte-vinum.html?utm_source=meta&utm_medium=paid_social&utm_campaign=il_montevinum_bofu_conv_mx_2026-05&utm_content=reel-15s_aspiracionaldrone_agendaconsulta_v01&utm_term=lal1pct-webvisitors_35-55
```

### Plataformas

| Plataforma | utm_source | utm_medium |
|-----------|-----------|-----------|
| Meta Ads | `meta` | `paid_social` |
| Google Search Ads | `google` | `cpc` |
| Google Display | `google` | `display` |
| YouTube Ads | `youtube` | `paid_social` |
| TikTok Ads | `tiktok` | `paid_social` |
| Email | `newsletter` | `email` |
| Instagram bio link | `instagram` | `organic_social` |
| WhatsApp orgánico | `whatsapp` | `messaging` |
| Partnership | `partner-[nombre]` | `referral` |

---

## Validación pre-launch

Antes de publicar cualquier campaña, validar:

- [ ] Nombre campaña sigue formato `IL_[Proyecto]_[Funnel]_[Obj]_[Geo]_[YYYY-MM]`
- [ ] Cada ad set agrega `__[Audiencia]_[Edad]_[Placement]`
- [ ] Cada anuncio agrega `___[Formato]_[Hook]_[CTA]_v[##]`
- [ ] URL final tiene los 5 UTMs (source, medium, campaign, content, term)
- [ ] UTMs todos en lowercase
- [ ] La URL final del anuncio se abre correctamente en navegador
- [ ] Pixel Helper de Chrome detecta evento al cargar la URL
- [ ] El link de WhatsApp en la página de proyecto se reescribe con `[il-ref:...]`

---

## Fuentes y referencias

- [Meta Ad Naming Conventions Best Practices](https://www.facebook.com/business/help)
- [Google Analytics URL Builder](https://ga-dev-tools.web.app/campaign-url-builder/)
- Estándar interno Infinity Legacy v1.0 (este documento)

**Cualquier cambio a este estándar debe documentarse aquí con nueva versión y fecha.**
